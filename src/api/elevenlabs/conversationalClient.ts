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
      }
    });
    
    this.socket = null;
    this.currentAudioStream = null;
    this.audioBufferQueue = [];
    this.isProcessing = false;
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
        }
      });

      this.socket.on('open', () => {
        logger.info('Successfully connected to ElevenLabs Conversational WebSocket.');
        resolve();
      });

      this.socket.on('error', error => {
        logger.error(error, 'WebSocket encountered an error');
        reject(new Error(`Error during WebSocket connection: ${error.message}`));
      });

      this.socket.on('close', (code: number, reason: string) => {
        logger.info(`ElevenLabs WebSocket closed with code ${code}. Reason: ${reason}`);
        this.cleanup();
      });

      this.socket.on('message', message => this.handleEvent(message));
    });
  }

  /**
   * Cleans up the current audio stream if it exists.
   * @private
   */
  private cleanup(): void {
    if (this.currentAudioStream && !this.currentAudioStream.destroyed) {
      this.currentAudioStream.push(null);
      this.currentAudioStream.destroy();
      this.currentAudioStream = null;
    }
  }

  /**
   * Disconnects from the ElevenLabs WebSocket.
   * @returns {void}
   */
  public disconnect(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close();
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
   * @returns {void}
   */
  private initializeAudioStream(): void {
    if (!this.currentAudioStream || this.currentAudioStream.destroyed) {
      logger.info('Initializing new audio stream for playback');
      this.currentAudioStream = new PassThrough({ highWaterMark: 1024 * 512 });
      
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

    while (this.audioBufferQueue.length > 0) {
      const audioBuffer = this.audioBufferQueue.shift()!;
      try {
        this.initializeAudioStream();
        logger.info(`Processing audio buffer of size ${audioBuffer.byteLength} bytes`);
        const pcmBuffer = await AudioUtils.mono441kHzToStereo48kHz(audioBuffer);
        logger.info(`Converted to PCM buffer of size ${pcmBuffer.byteLength} bytes`);
        
        if (this.currentAudioStream && !this.currentAudioStream.destroyed) {
          const writeSuccess = this.currentAudioStream.write(pcmBuffer);
          logger.info(`Audio buffer write success: ${writeSuccess}`);
        } else {
          logger.error('Current audio stream is not available or destroyed');
        }
      } catch (error) {
        logger.error('Error processing audio buffer:', error);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Handles the audio event received from the WebSocket.
   * @param {AudioEvent} message - The audio event message containing audio data.
   * @returns {Promise<void>} A promise that resolves when the audio is processed.
   */
  private async handleAudio(message: AudioEvent): Promise<void> {
    try {
      logger.info(`Received audio event with ${message.audio_event.audio_base_64.length} base64 characters`);
      const audioBuffer = Buffer.from(message.audio_event.audio_base_64, 'base64');
      logger.info(`Decoded audio buffer size: ${audioBuffer.byteLength} bytes`);
      
      if (audioBuffer.byteLength === 0) {
        logger.warn('Received empty audio buffer, skipping');
        return;
      }
      
      this.audioBufferQueue.push(audioBuffer);
      await this.processAudioQueue();
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
  }

  /**
   * Handles the user transcript event.
   * @param {UserTranscriptEvent} event - The user transcript event.
   * @returns {void}
   */
  private handleUserTranscript(event: UserTranscriptEvent): void {
    logger.info(event);
  }
}
