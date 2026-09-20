/** Metadata extracted from a media file by ffprobe. */
export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  bitrate: number | null;
}

/** The subset of ffprobe's JSON output this project reads. */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
}

export interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  size?: string;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}
