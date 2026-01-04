
export enum AspectRatio {
  SIXTEEN_NINE = '16:9',
}

export enum ArtStyle {
  INSECT_CARTOON = 'Insect Cartoon style',
}

export interface ContentIdea {
  title: string;
  hook: string;
}

export interface GeneratedMedia {
  originalScriptSegment: string;
  prompt: string;
  videoMotionPrompt?: string; 
  mediaUrl: string; 
  videoUrl?: string; 
  audioUrl?: string; 
  index: number;
  isProcessing?: boolean;
  isVideoProcessing?: boolean;
  isAudioProcessing?: boolean;
  isIntro?: boolean;
}

export interface SavedProject {
  id: string;
  timestamp: number;
  script: string;
  media: GeneratedMedia[];
  elevenLabsKey?: string;
  elevenLabsVoiceId?: string;
  aspectRatio?: string;
  artStyle?: string;
  customArtStyle?: string;
}
