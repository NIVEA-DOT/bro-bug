
import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { TEXT_ANALYSIS_MODEL, IMAGE_GENERATION_MODEL } from '../constants';
import { AspectRatio, ArtStyle, ContentIdea } from '../types';

// Helper to handle retries
async function callWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      return callWithRetry(fn, retries - 1);
    }
    throw error;
  }
}

function robustJsonParse(text: string | undefined): any {
  if (!text) throw new Error("AI 응답이 없습니다.");
  try {
    return JSON.parse(text.trim());
  } catch {
    try {
      let cleaned = text.replace(/```json\s*|```/g, '').trim();
      const startArr = cleaned.indexOf('[');
      const endArr = cleaned.lastIndexOf(']');
      const startObj = cleaned.indexOf('{');
      const endObj = cleaned.lastIndexOf('}');
      if (startArr !== -1 && endArr !== -1 && (startArr < startObj || startObj === -1)) {
        return JSON.parse(cleaned.substring(startArr, endArr + 1));
      } else if (startObj !== -1 && endObj !== -1) {
        return JSON.parse(cleaned.substring(startObj, endObj + 1));
      }
      throw new Error("JSON 형식을 찾을 수 없습니다.");
    } catch (e) {
      console.error("JSON 파싱 실패 원본 텍스트:", text);
      throw new Error("데이터 형식이 올바르지 않습니다. 다시 시도해 주세요.");
    }
  }
}

// Core Fixed Prompt (Style Bible) - Updated to Stylized 3D Cinematic (Pixar/Dreamworks)
const CORE_STYLE_INSTRUCTION = `
stylized 3D cinematic illustration, pixar style, dreamworks style, soft warm lighting, cinematic depth of field, global illumination, smooth plastic-like skin, highly detailed, ultra clean render, professional studio lighting, cozy indoor atmosphere, warm color palette, high quality 3d character render, octane render, unreal engine, 4k
`;

// Step 1: Generate Content Ideas
export async function generateContentIdeas(topic: string, apiKey: string): Promise<ContentIdea[]> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
    You are a YouTube viral content strategist.
    Generate 10 HIGH-CLICK-THROUGH-RATE (Clickbait/Viral) video ideas about the topic: "${topic}".
    
    Rules:
    1. Titles must be provocative, using psychological triggers (Curiosity, Fear, Greed, etc.).
    2. Hooks should be short sentences that explain why this video goes viral.
    3. Output MUST be in Korean (한국어).
    
    Return ONLY a JSON array:
    [
      { "title": "Stimulating Title 1", "hook": "Reason why it's interesting" },
      ...
    ]
  `;

  const response: GenerateContentResponse = await ai.models.generateContent({
    model: TEXT_ANALYSIS_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return robustJsonParse(response.text);
}

// Step 2: Generate Full Script
export async function generateFullScript(ideaTitle: string, apiKey: string): Promise<{ intro: string; body: string }> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
    Role: Professional YouTube Scriptwriter.
    Task: Write a very long, comprehensive, and engaging YouTube script for the title: "${ideaTitle}".
    Target Length: Approximately 8000 characters total (Korean).
    
    Structure:
    1. INTRO (Hook): Grab attention immediately, state the problem/mystery, and promise a solution/reveal. (approx 500-1000 chars)
    2. BODY (Main Content): Detailed storytelling, facts, arguments, or explanation. Divide into logical sections. Make it long and deep. (approx 7000 chars)
    
    Language: Korean (Natural, spoken style, engaging).
    
    Return ONLY a JSON object:
    {
      "intro": "Full intro script text...",
      "body": "Full body script text..."
    }
  `;

  const response: GenerateContentResponse = await ai.models.generateContent({
    model: 'gemini-3-pro-preview', // Using Pro for longer/better writing
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return robustJsonParse(response.text);
}

// Step 4 (Old Step 2): Analyze Segments
export async function analyzeSegmentsForPrompts(
  segments: string[],
  apiKey: string,
  onStatusUpdate?: (msg: string) => void
): Promise<{ scriptSegment: string; imagePrompt: string; videoMotionPrompt: string }[]> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });
  const results: { scriptSegment: string; imagePrompt: string; videoMotionPrompt: string }[] = [];
  
  // 배치 사이즈 유지 (안정성)
  const batchSize = 4;
  // Updated character description to fit the new Stylized 3D style
  const characterDescription = "A friendly and expressive 3D character in a stylized animation style, fitting the cozy and warm atmosphere.";

  for (let i = 0; i < segments.length; i += batchSize) {
    const currentBatch = segments.slice(i, i + batchSize);
    
    const contextPrompt = `
      [STYLE DEFINITION]
      ${CORE_STYLE_INSTRUCTION}

      [TASK: CONTINUOUS 3D ANIMATION STORYBOARD]
      Protagonist: ${characterDescription}
      
      Analyze the following ${currentBatch.length} text segments and generate visual prompts.
      
      Segments to analyze (in order):
      ${currentBatch.map((s, idx) => `Item ${idx}: ${s}`).join('\n')}
      
      OUTPUT RULES:
      1. Return a JSON Array with exactly ${currentBatch.length} objects.
      2. The order MUST match the input order (Item 0 -> Index 0).
      3. properties:
         - image_prompt: English description of the scene. Include character actions and facial expressions matching the text emotion. Ensure it fits the "Pixar/Dreamworks" 3D style.
         - video_motion_prompt: Simple camera motion description.
      4. DO NOT return the original Korean text.
    `;

    try {
        const response = await callWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: TEXT_ANALYSIS_MODEL,
            contents: contextPrompt,
            config: { 
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            image_prompt: { type: Type.STRING },
                            video_motion_prompt: { type: Type.STRING }
                        },
                        required: ["image_prompt", "video_motion_prompt"]
                    }
                }
            }
        }));
        
        const parsedData = JSON.parse(response.text || "[]");
        
        const mergedData = currentBatch.map((originalSegment, idx) => {
            const aiResult = parsedData[idx] || {};
            return {
                scriptSegment: originalSegment, 
                imagePrompt: aiResult.image_prompt || "A stylized 3D animation scene.",
                videoMotionPrompt: aiResult.video_motion_prompt || "Cinematic pan"
            };
        });
        
        results.push(...mergedData);

    } catch (e) {
        console.error("Batch Error:", e);
        const fallbackData = currentBatch.map(s => ({
            scriptSegment: s,
            imagePrompt: "A stylized 3D animation scene.",
            videoMotionPrompt: "Cinematic pan"
        }));
        results.push(...fallbackData);
    }

    onStatusUpdate?.(`비주얼 분석 중... (${Math.min(i + batchSize, segments.length)}/${segments.length})`);
  }
  return results;
}

export async function generateImage(
  prompt: string,
  apiKey: string
): Promise<string> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });
  
  // Updated to use the new Style Instruction
  const finalPrompt = `${CORE_STYLE_INSTRUCTION} 
  Scene Description: ${prompt}. 
  IMPORTANT: If there is any text inside the image, it MUST be written in Korean (Hangul). Do not use English text in the image.`;

  const response: GenerateContentResponse = await callWithRetry(() => ai.models.generateContent({
    model: IMAGE_GENERATION_MODEL,
    contents: { parts: [{ text: `High-quality 3D render, ${finalPrompt}. Clean and sharp, no artifacts.` }] },
    config: { imageConfig: { aspectRatio: AspectRatio.SIXTEEN_NINE, imageSize: "1K" } }
  }));
  const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
  if (part?.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  throw new Error("이미지 생성 도중 오류가 발생했습니다.");
}

export async function generateThumbnailText(script: string, apiKey: string): Promise<{ topText: string; bottomText: string }> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: TEXT_ANALYSIS_MODEL,
    contents: `자극적인 썸네일 문구 2줄 생성. 대본: ${script.slice(0, 1000)}\n{"topText": "1행", "bottomText": "2행"}`,
    config: { responseMimeType: "application/json" }
  });
  return robustJsonParse(response.text);
}

export async function refineScript(script: string, prompt: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: TEXT_ANALYSIS_MODEL,
    contents: `대본 수정: ${prompt}\n대본: ${script}`
  });
  return response.text || script;
}

export async function generateVideoFromImage(imageBase64: string, motionPrompt: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error("Google Gemini API Key가 필요합니다.");
  const ai = new GoogleGenAI({ apiKey });
  let operation = await ai.models.generateVideos({
    model: 'veo-3.1-fast-generate-preview',
    prompt: motionPrompt,
    image: { imageBytes: imageBase64.split(',')[1], mimeType: 'image/png' },
    config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' }
  });
  while (!operation.done) {
    await new Promise(r => setTimeout(r, 10000));
    operation = await ai.operations.getVideosOperation({ operation });
  }
  return operation.response?.generatedVideos?.[0]?.video?.uri || "";
}
