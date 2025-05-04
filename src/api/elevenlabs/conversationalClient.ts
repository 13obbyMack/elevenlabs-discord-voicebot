import { AudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { PassThrough } from 'stream';
import WebSocket from 'ws';
import { ELEVENLABS_CONFIG } from '../../config/config.js';
import { logger } from '../../config/index.js';
import { AudioUtils } from '../../utils/index.js';
import type { AgentResponseEvent, AudioEvent, UserTranscriptEvent } from './types.js';

/**
 * Manages the ElevenLabs Conversational AI WebSocket.
 */
export class ElevenLabsConversationalAI {
  private url: string;
  private socket: WebSocket | null;
  private audioPlayer: AudioPlayer;
  private currentAudioStream: PassThrough | null;
  private audioBufferQueue: Buffer[];
  private isProcessing: boolean;
  private pendingAudioCompletion: boolean;
  private audioEndTimeout: NodeJS.Timeout | null;
  private keepAliveInterval: NodeJS.Timeout | null;
  private reconnectAttempts: number;
  private maxReconnectAttempts: number;

  /**
   * Creates an instance of ElevenLabsConversationalAI.
   * @param {AudioPlayer} audioPlayer - The audio player instance.
   */
  constructor(audioPlayer: AudioPlayer) {
    this.url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_CONFIG.AGENT_ID}`;
    this.audioPlayer = audioPlayer;
    
    // Add audio player state logging
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      logger.info(`Audio player state changed from ${oldState.status} to ${newState.status}`);
      
      if (newState.status === 'playing') {
        logger.info('Audio is now playing');
      } else if (newState.status === 'idle') {
        logger.info('Audio player is now idle');
        // If we still have pending audio to process, reinitialize the stream
        if (this.pendingAudioCompletion && (this.audioBufferQueue.length > 0 || this.isProcessing)) {
          logger.info('Audio player went idle but we still have pending audio - reinitializing stream');
          this.initializeAudioStream();
        } else if (this.pendingAudioCompletion) {
          // Set a timeout to ensure we've received all audio chunks before ending
          this.audioEndTimeout = setTimeout(() => {
            logger.info('Audio completion timeout reached, finalizing audio');
            this.pendingAudioCompletion = false;
          }, 2000); // 2 second grace period for any final chunks
        }
      }
    });
    
    this.socket = null;
    this.currentAudioStream = null;
    this.audioBufferQueue = [];
    this.isProcessing = false;
    this.pendingAudioCompletion = false;
    this.audioEndTimeout = null;
    this.keepAliveInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  /**
   * Connects to the ElevenLabs WebSocket.
   * @returns {Promise<void>} A promise that resolves when the connection is established.
   */
  public async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      logger.info('Establishing connection to ElevenLabs Conversational WebSocket...');
      logger.info(`Using API key: ${ELEVENLABS_CONFIG.API_KEY ? 'API key is set' : 'API key is NOT set'}`);
      
      // For debugging purposes only - check if we're getting the API key from env
      if (!ELEVENLABS_CONFIG.API_KEY) {
        logger.error('ELEVENLABS_API_KEY is not set in environment variables');
      }
      
      this.socket = new WebSocket(this.url, {
        headers: {
          'xi-api-key': ELEVENLABS_CONFIG.API_KEY
        },
        perMessageDeflate: {
          zlibDeflateOptions: {
            level: 6, // Compression level (1-9, where 9 is highest but slowest)
            memLevel: 8, // Memory allocation for compression (1-9, where 9 uses most memory)
          },
          zlibInflateOptions: {
            chunkSize: 32 * 1024 // Chunk size for decompression
          },
          serverNoContextTakeover: false, // Allow server to maintain compression context
          clientNoContextTakeover: false, // Allow client to maintain compression context
          threshold: 512 // Only compress messages larger than this size in bytes
        }
      });

      this.socket.on('open', () => {
        logger.info('Successfully connected to ElevenLabs Conversational WebSocket.');
        
        // Reset reconnect attempts on successful connection
        this.reconnectAttempts = 0;
        
        // Start the keep-alive mechanism
        this.startKeepAlive();
        
        resolve();
      });

      this.socket.on('error', error => {
        logger.error(error, 'WebSocket encountered an error');
        this.stopKeepAlive();
        reject(new Error(`Error during WebSocket connection: ${error.message}`));
      });

      this.socket.on('close', (code: number, reason: string) => {
        logger.info(`ElevenLabs WebSocket closed with code ${code}. Reason: ${reason}`);
        this.stopKeepAlive();
        
        // Attempt to reconnect if the connection was closed unexpectedly
        if (code !== 1000 && code !== 1001) { // 1000 = normal closure, 1001 = going away
          this.attemptReconnect();
        } else {
          // Don't immediately clean up - wait for any pending audio to finish playing
          if (this.pendingAudioCompletion) {
            logger.info('WebSocket closed but audio is still pending - delaying cleanup');
            // Set a timeout to allow any remaining audio to be processed
            setTimeout(() => {
              logger.info('Performing delayed cleanup after WebSocket close');
              this.cleanup();
            }, 5000); // 5 second delay to allow audio to finish
          } else {
            this.cleanup();
          }
        }
      });

      this.socket.on('message', message => this.handleEvent(message));
    });
  }

  /**
   * Starts the WebSocket keep-alive mechanism.
   * @private
   */
  private startKeepAlive(): void {
    // Clear any existing interval
    this.stopKeepAlive();
    
    // Send a ping every 15 seconds to keep the connection alive
    this.keepAliveInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        logger.debug('Sending keep-alive ping');
        
        // Send an empty message as a ping to keep the connection alive
        const pingMessage = { ping: true };
        this.socket.send(JSON.stringify(pingMessage));
      }
    }, 15000); // 15 seconds
    
    logger.info('WebSocket keep-alive mechanism started');
  }

  /**
   * Stops the WebSocket keep-alive mechanism.
   * @private
   */
  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      logger.info('WebSocket keep-alive mechanism stopped');
    }
  }

  /**
   * Attempts to reconnect to the WebSocket server.
   * @private
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      
      // Modified backoff: faster initial reconnects (0.5, 1, 2, 4, 8 seconds)
      const backoffTime = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      
      logger.info(`Attempting to reconnect in ${backoffTime/1000} seconds (attempt ${this.reconnectAttempts} of ${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        logger.info('Attempting to reconnect to WebSocket...');
        this.connect().catch(error => {
          logger.error('Reconnection attempt failed:', error);
        });
      }, backoffTime);
    } else {
      logger.error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
    }
  }

  /**
   * Disconnects from the ElevenLabs WebSocket.
   * @returns {void}
   */
  public disconnect(): void {
    this.stopKeepAlive();
    
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close(1000, 'Client disconnected');
    }
    this.cleanup();
  }

  /**
   * Appends input audio to the WebSocket.
   * @param {Buffer} buffer - The audio buffer to append.
   * @returns {void}
   */
  appendInputAudio(buffer: Buffer): void {
    if (buffer.byteLength === 0 || this.socket?.readyState !== WebSocket.OPEN) return;

    const base64Audio = {
      user_audio_chunk: buffer.toString('base64'),
    };
    this.socket?.send(JSON.stringify(base64Audio));
  }

  /**
   * Handles an interruption during the conversation.
   * @private
   * @returns {void}
   */
  private handleInterruption(): void {
    this.audioPlayer.stop();
    logger.info('Conversation interrupted.');
  }

  /**
   * Initializes the audio stream for playback.
   * @private
   * @returns {Promise<void>} A promise that resolves when the stream is ready
   */
  private async initializeAudioStream(): Promise<void> {
    if (!this.currentAudioStream || this.currentAudioStream.destroyed) {
      logger.info('Initializing new audio stream for playback');
      // Reduce the highWaterMark to balance buffering and latency
      this.currentAudioStream = new PassThrough({ 
        highWaterMark: 512 * 1024,  // Reduced from 2MB to 512KB buffer
        emitClose: false // Prevent premature close events
      });
      
      // Add event listeners to the stream
      this.currentAudioStream.on('close', () => {
        logger.info('Audio stream closed');
      });
      
      this.currentAudioStream.on('error', (err) => {
        // Only log actual errors with messages
        if (err && err.message) {
          logger.error('Audio stream error:', err.message);
        }
      });
      
      const resource = createAudioResource(this.currentAudioStream, {
        inputType: StreamType.Raw,
        inlineVolume: true
      });
      
      // Set volume to maximum
      if (resource.volume) {
        resource.volume.setVolume(1.0);
      }
      
      logger.info('Playing audio resource');
      this.audioPlayer.play(resource);
      
      // Reduce wait time for player initialization
      await new Promise(resolve => setTimeout(resolve, 20)); // Reduced from 50ms to 20ms
    }
  }

  /**
   * Processes the audio buffer queue and writes audio to the current audio stream.
   * @private
   * @returns {Promise<void>} A promise that resolves when the processing is complete.
   */
  private async processAudioQueue(): Promise<void> {
    if (this.isProcessing || this.audioBufferQueue.length === 0) return;

    this.isProcessing = true;
    logger.info(`Processing audio queue with ${this.audioBufferQueue.length} buffers`);

    try {
      // Process all buffers in the queue
      const buffers = [...this.audioBufferQueue];
      this.audioBufferQueue = [];
      
      // Make sure we have an audio stream ready
      await this.initializeAudioStream();
      
      // Process each buffer sequentially
      for (const audioBuffer of buffers) {
        try {
          if (!this.currentAudioStream || this.currentAudioStream.destroyed) {
            logger.info('Audio stream was destroyed during processing, reinitializing');
            await this.initializeAudioStream();
          }
          
          logger.info(`Processing audio buffer of size ${audioBuffer.byteLength} bytes`);
          const pcmBuffer = await AudioUtils.mono441kHzToStereo48kHz(audioBuffer);
          logger.info(`Converted to PCM buffer of size ${pcmBuffer.byteLength} bytes`);
          
          if (pcmBuffer.byteLength === 0) {
            logger.warn('Converted buffer is empty, skipping');
            continue;
          }
          
          // Double-check stream is still available before writing
          if (!this.currentAudioStream || this.currentAudioStream.destroyed) {
            logger.warn('Stream became unavailable after conversion, reinitializing');
            await this.initializeAudioStream();
          }
          
          if (this.currentAudioStream && !this.currentAudioStream.destroyed) {
            // Implement improved backpressure handling with adaptive timeout
            if (!this.currentAudioStream.write(pcmBuffer)) {
              logger.info('Stream backpressure detected, waiting for drain event');
              await new Promise<void>(resolve => {
                const onDrain = () => {
                  this.currentAudioStream?.removeListener('drain', onDrain);
                  logger.info('Stream drain event received, continuing processing');
                  resolve();
                };
                
                this.currentAudioStream!.on('drain', onDrain);
                
                // Adaptive timeout based on buffer size
                const timeoutMs = Math.min(Math.max(pcmBuffer.byteLength / 1024, 500), 2000);
                setTimeout(() => {
                  this.currentAudioStream?.removeListener('drain', onDrain);
                  logger.warn(`Drain event timeout reached after ${timeoutMs}ms, continuing anyway`);
                  resolve();
                }, timeoutMs); // Adaptive timeout between 500ms and 2000ms
              });
            } else {
              logger.info('Audio buffer write successful');
            }
          } else {
            logger.error('Current audio stream is not available or destroyed');
            // Reinitialize the stream if needed
            await this.initializeAudioStream();
            
            // Try writing again after reinitialization
            if (this.currentAudioStream) {
              const writeSuccess = this.currentAudioStream.write(pcmBuffer);
              logger.info(`Retry audio buffer write success: ${writeSuccess}`);
            }
          }
          
          // Reduced delay between chunks to improve responsiveness
          await new Promise(resolve => setTimeout(resolve, 15)); // Reduced from 30ms to 15ms
          
        } catch (error) {
          logger.error('Error processing audio buffer:', error);
          // Continue processing other buffers even if one fails
        }
      }
      
      // If we have more buffers that were added during processing, process them too
      if (this.audioBufferQueue.length > 0) {
        logger.info(`Additional ${this.audioBufferQueue.length} buffers were added during processing, continuing`);
        this.isProcessing = false;
        await this.processAudioQueue();
        return;
      }
      
      // Ensure the stream stays open for a short period after processing all buffers
      // to catch any late-arriving chunks
      if (this.currentAudioStream && !this.currentAudioStream.destroyed) {
        logger.info('All audio buffers processed, keeping stream open for potential additional chunks');
        
        // Add a small amount of silence at the end to prevent abrupt cutoffs
        const silenceBuffer = Buffer.alloc(4800); // 50ms of silence at 48kHz stereo
        this.currentAudioStream.write(silenceBuffer);
      }
    } catch (error) {
      logger.error('Error in processAudioQueue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handles the audio event received from the WebSocket.
   * @param {AudioEvent} message - The audio event message containing audio data.
   * @returns {Promise<void>} A promise that resolves when the audio is processed.
   */
  private async handleAudio(message: AudioEvent): Promise<void> {
    try {
      // Mark that we're expecting audio data
      this.pendingAudioCompletion = true;
      
      // Clear any existing end timeout since we're receiving new audio
      if (this.audioEndTimeout) {
        clearTimeout(this.audioEndTimeout);
        this.audioEndTimeout = null;
      }
      
      logger.info(`Received audio event with ${message.audio_event.audio_base_64.length} base64 characters`);
      const audioBuffer = Buffer.from(message.audio_event.audio_base_64, 'base64');
      logger.info(`Decoded audio buffer size: ${audioBuffer.byteLength} bytes`);
      
      if (audioBuffer.byteLength === 0) {
        logger.warn('Received empty audio buffer, skipping');
        return;
      }
      
      // For large buffers, chunk them to prevent overwhelming the audio stream
      if (audioBuffer.byteLength > 100000) { // ~100KB threshold
        const chunks = AudioUtils.chunkAudioBuffer(audioBuffer, 65536); // 64KB chunks
        logger.info(`Split large audio buffer into ${chunks.length} chunks`);
        
        // Add chunks to queue in order
        this.audioBufferQueue.push(...chunks);
      } else {
        this.audioBufferQueue.push(audioBuffer);
      }
      
      // If we're not currently processing, start processing the queue
      if (!this.isProcessing) {
        await this.processAudioQueue();
      }
    } catch (error) {
      logger.error('Error handling audio event:', error);
    }
  }

  /**
   * Handles events received from the WebSocket.
   * @param {WebSocket.RawData} message - The raw data message.
   * @returns {void}
   */
  private handleEvent(message: WebSocket.RawData): void {
    const event = JSON.parse(message.toString());

    // Ignore ping responses
    if (event.pong === true) {
      logger.debug('Received pong response');
      return;
    }

    switch (event.type) {
      case 'agent_response':
        this.handleAgentResponse(event);
        break;
      case 'user_transcript':
        this.handleUserTranscript(event);
        break;
      case 'audio':
        this.handleAudio(event);
        break;
      case 'interruption':
        this.handleInterruption();
        break;
    }
  }

  /**
   * Handles the agent response event.
   * @param {AgentResponseEvent} event - The agent response event.
   * @returns {void}
   */
  private handleAgentResponse(event: AgentResponseEvent): void {
    logger.info(event);
    // Mark that we're expecting audio data to follow this response
    this.pendingAudioCompletion = true;
  }

  /**
   * Handles the user transcript event.
   * @param {UserTranscriptEvent} event - The user transcript event.
   * @returns {void}
   */
  private handleUserTranscript(event: UserTranscriptEvent): void {
    logger.info(event);
  }

  /**
   * Cleans up the current audio stream if it exists.
   * @private
   */
  private cleanup(): void {
    // Clear any pending timeouts
    if (this.audioEndTimeout) {
      clearTimeout(this.audioEndTimeout);
      this.audioEndTimeout = null;
    }
    
    // Process any remaining audio in the queue before cleaning up
    if (this.audioBufferQueue.length > 0 && !this.isProcessing) {
      logger.info(`Processing ${this.audioBufferQueue.length} remaining buffers before cleanup`);
      this.processAudioQueue().then(() => {
        logger.info('Final audio processing complete, now cleaning up stream');
        this.finalizeCleanup();
      });
    } else {
      this.finalizeCleanup();
    }
  }
  
  /**
   * Finalizes the cleanup by destroying the audio stream.
   * @private
   */
  private finalizeCleanup(): void {
    if (this.currentAudioStream && !this.currentAudioStream.destroyed) {
      // Add a small delay before destroying to ensure all data is flushed
      setTimeout(() => {
        logger.info('Destroying audio stream');
        if (this.currentAudioStream) {
          this.currentAudioStream.push(null);
          this.currentAudioStream.destroy();
          this.currentAudioStream = null;
        }
      }, 500);
    }
    
    // Reset state
    this.pendingAudioCompletion = false;
    this.audioBufferQueue = [];
  }
}
