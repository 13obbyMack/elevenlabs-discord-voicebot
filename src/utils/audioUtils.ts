import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import { logger } from '../config/index.js';

/**
 * Utility class for audio processing operations.
 */
class AudioUtils {
  /**
   * Converts mono 44.1kHz PCM audio to stereo 48kHz PCM audio.
   *
   * @param inputBuffer - The input PCM audio buffer in mono 44.1kHz format (signed 16-bit little-endian)
   * @returns Promise resolving to a Buffer containing stereo 48kHz PCM audio (signed 16-bit little-endian)
   * @throws {Error} If FFmpeg processing fails
   *
   */
  static async mono441kHzToStereo48kHz(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      // Log the input buffer details
      logger.info(`Converting audio: Input buffer size ${inputBuffer.byteLength} bytes`);
      
      // Handle empty buffers gracefully
      if (inputBuffer.byteLength === 0) {
        logger.warn('Empty input buffer received, returning empty output');
        return resolve(Buffer.alloc(0));
      }

      // Set a timeout to prevent hanging conversion processes
      const timeout = setTimeout(() => {
        logger.error('Audio conversion timed out after 5 seconds');
        reject(new Error('Audio conversion timed out'));
      }, 5000);

      ffmpeg(Readable.from(inputBuffer))
        .inputFormat('s16le')
        .inputOptions(['-ar 44100', '-ac 1', '-f s16le'])
        .outputFormat('s16le')
        .outputOptions([
          '-ar 48000',  // Discord.js requires 48kHz
          '-ac 2',      // Discord.js requires stereo
          '-af aresample=async=1:first_pts=0',
          '-f s16le'
        ])
        .on('error', err => {
          clearTimeout(timeout);
          // Don't fail the entire process for non-critical errors
          if (err.message.includes('Output stream closed') && chunks.length > 0) {
            logger.warn(`FFmpeg warning: ${err.message}, but we have partial data. Continuing...`);
            const result = Buffer.concat(chunks);
            logger.info(`Partial audio conversion complete: Output buffer size ${result.byteLength} bytes`);
            resolve(result);
          } else {
            logger.error(`FFmpeg error: ${err.message}`);
            reject(new Error(`FFmpeg error: ${err.message}`));
          }
        })
        .pipe()
        .on('data', chunk => chunks.push(chunk))
        .on('end', () => {
          clearTimeout(timeout);
          const result = Buffer.concat(chunks);
          logger.info(`Audio conversion complete: Output buffer size ${result.byteLength} bytes`);
          resolve(result);
        });
    });
  }

  /**
   * Chunks a large audio buffer into smaller pieces to prevent buffer overflow
   * 
   * @param buffer - The large audio buffer to chunk
   * @param maxChunkSize - Maximum size of each chunk in bytes
   * @returns Array of smaller buffer chunks
   */
  static chunkAudioBuffer(buffer: Buffer, maxChunkSize: number = 65536): Buffer[] {
    const chunks: Buffer[] = [];
    let offset = 0;
    
    // Ensure chunk size is even (for 16-bit audio)
    maxChunkSize = maxChunkSize - (maxChunkSize % 2);
    
    while (offset < buffer.length) {
      const chunkSize = Math.min(maxChunkSize, buffer.length - offset);
      chunks.push(buffer.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }
    
    logger.info(`Chunked audio buffer of size ${buffer.length} into ${chunks.length} chunks`);
    return chunks;
  }

  /**
   * Checks if an audio buffer contains mostly silence.
   * @param {Buffer} buffer - The PCM audio buffer to check.
   * @param {number} threshold - The amplitude threshold below which is considered silence (0-255).
   * @param {number} silencePercentage - The percentage of samples that must be below threshold to consider as silence.
   * @returns {boolean} True if the buffer is mostly silence, false otherwise.
   */
  static isSilence(buffer: Buffer, threshold: number = 5, silencePercentage: number = 0.95): boolean {
    if (buffer.length === 0) return true;
    
    // Count samples below threshold
    let silentSamples = 0;
    const totalSamples = buffer.length;
    
    // Check every sample in the buffer
    for (let i = 0; i < totalSamples; i++) {
      if (Math.abs(buffer[i] - 128) <= threshold) {
        silentSamples++;
      }
    }
    
    // Calculate percentage of silent samples
    const silenceRatio = silentSamples / totalSamples;
    
    return silenceRatio >= silencePercentage;
  }
}

export { AudioUtils };
