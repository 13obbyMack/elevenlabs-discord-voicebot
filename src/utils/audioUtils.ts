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
          logger.error(`FFmpeg error: ${err.message}`);
          reject(new Error(`FFmpeg error: ${err.message}`));
        })
        .pipe()
        .on('data', chunk => chunks.push(chunk))
        .on('end', () => {
          const result = Buffer.concat(chunks);
          logger.info(`Audio conversion complete: Output buffer size ${result.byteLength} bytes`);
          resolve(result);
        });
    });
  }
}

export { AudioUtils };
