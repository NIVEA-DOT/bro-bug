
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  analyzeSegmentsForPrompts, 
  generateImage, 
  refineScript, 
  generateVideoFromImage, 
  generateThumbnailText,
  generateContentIdeas,
  generateFullScript 
} from './services/geminiService';
import { generateTTS } from './services/elevenLabsService';
import { saveProject, getProjects, deleteProject } from './services/storageService';
import { GeneratedMedia, SavedProject, ContentIdea } from './types';
import { DEFAULT_ASPECT_RATIO, DEFAULT_ART_STYLE } from './constants';
import Button from './components/Button';
import MediaCard from './components/ImageCard';
import HistoryModal from './components/HistoryModal';
import ApiKeyModal from './components/ApiKeyModal';
import ThumbnailModal from './components/ThumbnailModal';
import AuthPage from './components/AuthPage';
import { auth } from './services/firebase';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import JSZip from 'jszip';

// Default topics for Step 1
const DEFAULT_TOPICS = ["미스터리/공포", "돈 버는 법/부업", "최신 기술/AI", "연애 심리", "건강/다이어트", "역사 속 비하인드", "동기부여/자기계발"];

const App: React.FC = () => {
  // Auth State
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Workflow Step State (1: Idea, 2: Script Gen, 3: Edit, 4: Plan, 5: Prod)
  const [currentStep, setCurrentStep] = useState<number>(1);
  
  // Step 1: Idea Generation
  const [topic, setTopic] = useState<string>('');
  const [ideas, setIdeas] = useState<ContentIdea[]>([]);
  const [selectedIdea, setSelectedIdea] = useState<ContentIdea | null>(null);

  // Step 3 (Formerly Step 1): Input/Edit Script
  const [introScript, setIntroScript] = useState<string>('');
  const [bodyScript, setBodyScript] = useState<string>('');

  // Step 4 & 5 Data
  const [generatedMedia, setGeneratedMedia] = useState<GeneratedMedia[]>([]);
  
  // Settings & Keys (Initialized as empty, loaded in useEffect based on User ID)
  const [googleApiKey, setGoogleApiKey] = useState<string>('');
  const [elevenLabsKey, setElevenLabsKey] = useState<string>('');
  const [voiceId, setVoiceId] = useState<string>('nPczCjzI2devNBz1zWbc');

  // Loading States
  const [loadingType, setLoadingType] = useState<'none' | 'ideas' | 'script' | 'planning' | 'image' | 'video' | 'audio' | 'zip' | 'single_image'>('none');
  const [progress, setProgress] = useState<number>(0); 
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null); 

  // Modals
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showThumbnailModal, setShowThumbnailModal] = useState<boolean>(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [historyProjects, setHistoryProjects] = useState<SavedProject[]>([]);

  // Auth Effect
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Load User Specific Keys
  useEffect(() => {
    if (user) {
      setGoogleApiKey(localStorage.getItem(`google_api_key_${user.uid}`) || '');
      setElevenLabsKey(localStorage.getItem(`elevenlabs_key_${user.uid}`) || '');
      setVoiceId(localStorage.getItem(`elevenlabs_voice_id_${user.uid}`) || 'nPczCjzI2devNBz1zWbc');
    } else {
      setGoogleApiKey('');
      setElevenLabsKey('');
      setVoiceId('nPczCjzI2devNBz1zWbc');
    }
  }, [user]);

  // Save User Specific Keys
  useEffect(() => {
    if (user) {
      localStorage.setItem(`google_api_key_${user.uid}`, googleApiKey);
      localStorage.setItem(`elevenlabs_key_${user.uid}`, elevenLabsKey);
      localStorage.setItem(`elevenlabs_voice_id_${user.uid}`, voiceId);
    }
  }, [googleApiKey, elevenLabsKey, voiceId, user]);

  // Handle Logout
  const handleLogout = async () => {
    try {
      await signOut(auth);
      setCurrentStep(1);
      setTopic('');
      setIdeas([]);
      setSelectedIdea(null);
      setIntroScript('');
      setBodyScript('');
      setGeneratedMedia([]);
    } catch (e) {
      console.error("Logout failed", e);
    }
  };

  // --- Step 1: Generate Ideas ---
  const handleGenerateIdeas = async (inputTopic: string) => {
    if (!inputTopic.trim()) { setError("주제를 입력하거나 선택해주세요."); return; }
    if (!googleApiKey) { setError("Google Gemini API 키가 설정되지 않았습니다."); setShowSettings(true); return; }

    setLoadingType('ideas');
    setLoadingStatus(`${inputTopic} 관련 아이디어 추출 중...`);
    try {
      const generated = await generateContentIdeas(inputTopic, googleApiKey);
      setIdeas(generated);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingType('none');
    }
  };

  // --- Step 2: Generate Script ---
  const handleGenerateScript = async () => {
    if (!selectedIdea) { setError("아이디어를 선택해주세요."); return; }
    if (!googleApiKey) { setError("Google Gemini API 키가 필요합니다."); setShowSettings(true); return; }

    setLoadingType('script');
    setLoadingStatus(`"${selectedIdea.title}" 대본(약 8000자) 생성 중... 시간이 걸릴 수 있습니다.`);
    try {
      const { intro, body } = await generateFullScript(selectedIdea.title, googleApiKey);
      setIntroScript(intro);
      setBodyScript(body);
      setCurrentStep(3); // Move to Edit Step
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingType('none');
    }
  };

  // --- Logic: Semantic Sentence Splitter by Character Length ---
  const splitAndGroupSentences = (text: string, targetLength: number): string[] => {
    if (!text) return [];
    
    // 줄바꿈을 공백으로 치환하여 문단 전체를 하나의 텍스트 스트림으로 처리 (문맥 끊김 방지)
    const sanitizedText = text.replace(/\n/g, ' ');
    
    // 1. 문장 단위로 분리
    const rawSentences = sanitizedText.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [sanitizedText];
    const sentences = rawSentences.map(s => s.trim()).filter(s => s.length > 0);
    
    const finalSegments: string[] = [];
    let currentGroup = "";

    sentences.forEach((sentence) => {
      // 2. 현재 그룹이 비어있으면 무조건 담기
      if (currentGroup.length === 0) {
        currentGroup = sentence;
      } 
      // 3. 현재 그룹에 문장을 더해도 목표 길이보다 작으면 병합
      else if (currentGroup.length + sentence.length < targetLength) {
        currentGroup += " " + sentence;
      } 
      // 4. 목표 길이를 넘어가면 현재 그룹을 확정하고, 새 그룹 시작
      else {
        finalSegments.push(currentGroup);
        currentGroup = sentence;
      }
    });

    // 마지막 남은 그룹 처리
    if (currentGroup.length > 0) {
      finalSegments.push(currentGroup);
    }

    return finalSegments;
  };

  // --- Step 3 -> Step 4: Analyze & Plan ---
  const handleAnalyzeAndPlan = async () => {
    if (!introScript.trim() && !bodyScript.trim()) { setError("대본을 입력해주세요."); return; }
    if (!googleApiKey) { setError("Google Gemini API 키가 설정되지 않았습니다."); setShowSettings(true); return; }

    setLoadingType('planning');
    setError(null);
    setProgress(0);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Intro: 80자 이상 (호흡 빠름)
      // Body: 120자 이상 (호흡 널널함, 대략 100~150자 구간에 이미지 1장)
      const introSegments = splitAndGroupSentences(introScript, 80);
      const bodySegments = splitAndGroupSentences(bodyScript, 120); 
      
      const allSegments = [...introSegments, ...bodySegments];
      const introCount = introSegments.length;

      setLoadingStatus(`총 ${allSegments.length}개 장면으로 분석 및 프롬프트 생성 중...`);
      const sceneData = await analyzeSegmentsForPrompts(allSegments, googleApiKey, (msg) => setLoadingStatus(msg));

      const plannedMedia: GeneratedMedia[] = sceneData.map((data, index) => ({
        originalScriptSegment: data.scriptSegment,
        prompt: data.imagePrompt,
        videoMotionPrompt: data.videoMotionPrompt,
        mediaUrl: "", 
        index: index + 1,
        isProcessing: false,
        isIntro: index < introCount
      }));

      setGeneratedMedia(plannedMedia);
      setCurrentStep(4);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingType('none');
    }
  };

  // --- Step 4 -> Step 5: Confirm ---
  const handleConfirmPlan = () => {
    setCurrentStep(5);
  };

  // --- Step 5: Production ---
  const handleGenerateSingleImage = async (index: number) => {
    // Non-blocking single image generation
    try {
      setGeneratedMedia(prev => prev.map(p => p.index === index ? { ...p, isProcessing: true } : p));
      const item = generatedMedia.find(p => p.index === index);
      if (!item) return;

      const url = await generateImage(item.prompt, googleApiKey);
      setGeneratedMedia(prev => prev.map(p => p.index === index ? { ...p, mediaUrl: url, isProcessing: false } : p));
      
      saveProject({
        id: Date.now().toString(),
        timestamp: Date.now(),
        script: introScript + "\n\n" + bodyScript,
        media: generatedMedia, 
        aspectRatio: DEFAULT_ASPECT_RATIO,
        artStyle: DEFAULT_ART_STYLE
      });
    } catch(e:any) {
       setError(e.message);
       setGeneratedMedia(prev => prev.map(p => p.index === index ? { ...p, isProcessing: false } : p));
    }
  };

  const handleStartProduction = async () => {
    // Blocking batch generation with Global Modal
    setLoadingType('image'); // This triggers the global modal
    setError(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const pendingItems = generatedMedia.filter(m => !m.mediaUrl);
      const totalItems = generatedMedia.length;
      let completedCount = totalItems - pendingItems.length;

      for (const item of pendingItems) {
        if (controller.signal.aborted) break;
        
        // Update both global modal status and local card status
        const progressPercent = Math.round(((completedCount) / totalItems) * 100);
        setLoadingStatus(`현재 ${completedCount + 1} / 전체 ${totalItems} 장 생성 중... (${progressPercent}%)`);
        setProgress(progressPercent);
        
        setGeneratedMedia(prev => prev.map(p => p.index === item.index ? { ...p, isProcessing: true } : p));

        try {
          // Rate limit buffer
          if (completedCount > 0) await new Promise(r => setTimeout(r, 2000));
          
          const url = await generateImage(item.prompt, googleApiKey);
          setGeneratedMedia(prev => prev.map(p => p.index === item.index ? { ...p, mediaUrl: url, isProcessing: false } : p));
          completedCount++;
        } catch (e) {
          console.error(`Error generating scene ${item.index}`, e);
          setGeneratedMedia(prev => prev.map(p => p.index === item.index ? { ...p, isProcessing: false } : p));
        }
      }
      
      if (!controller.signal.aborted) {
        saveProject({
          id: Date.now().toString(),
          timestamp: Date.now(),
          script: introScript + "\n\n" + bodyScript,
          media: generatedMedia, 
          aspectRatio: DEFAULT_ASPECT_RATIO,
          artStyle: DEFAULT_ART_STYLE
        });
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingType('none');
    }
  };

  const handleGenerateVideo = async (index: number) => {
    const media = generatedMedia.find(m => m.index === index);
    if (!media || !media.mediaUrl || media.videoUrl) return;
    
    // Non-blocking video generation
    setGeneratedMedia(prev => prev.map(m => m.index === index ? { ...m, isVideoProcessing: true } : m));
    try {
      const vUrl = await generateVideoFromImage(media.mediaUrl, media.videoMotionPrompt || "Cinematic pan.", googleApiKey);
      setGeneratedMedia(prev => prev.map(m => m.index === index ? { ...m, videoUrl: vUrl, isVideoProcessing: false } : m));
    } catch (e: any) { 
      setError(e.message); 
      setGeneratedMedia(prev => prev.map(m => m.index === index ? { ...m, isVideoProcessing: false } : m)); 
    }
  };

  const handleGenerateTTS = async (index: number) => {
    const media = generatedMedia.find(m => m.index === index);
    if (!media) return;
    if (!elevenLabsKey) { setError("ElevenLabs API Key를 먼저 설정하세요."); setShowSettings(true); return; }
    
    // Non-blocking TTS generation for single item
    setGeneratedMedia(prev => prev.map(m => m.index === index ? { ...m, isAudioProcessing: true } : m));
    try {
      const aUrl = await generateTTS(media.originalScriptSegment, elevenLabsKey, voiceId);
      setGeneratedMedia(prev => prev.map(m => m.index === index ? { ...m, audioUrl: aUrl, isAudioProcessing: false } : m));
    } catch (e: any) { 
      setError(e.message); 
      setGeneratedMedia(prev => prev.map(m => m.index === index ? { ...m, isAudioProcessing: false } : m)); 
    }
  };

  const handleGenerateAllTTS = async () => {
    if (!elevenLabsKey) { setError("ElevenLabs API Key를 먼저 설정하세요."); setShowSettings(true); return; }
    setLoadingType('audio');
    let count = 0;
    for (const m of generatedMedia) {
      if (m.audioUrl) continue;
      setProgress(Math.round((++count / generatedMedia.length) * 100));
      try {
        const aUrl = await generateTTS(m.originalScriptSegment, elevenLabsKey, voiceId);
        setGeneratedMedia(prev => prev.map(item => item.index === m.index ? { ...item, audioUrl: aUrl } : item));
        await new Promise(r => setTimeout(r, 500));
      } catch (e: any) { setError(e.message); break; }
    }
    setLoadingType('none');
  };

  const handleFinalZipDownload = async () => {
    if (generatedMedia.length === 0) return;
    setLoadingType('zip'); setProgress(0);
    try {
      const zip = new JSZip();
      const imageFolder = zip.folder("images");
      const audioFolder = zip.folder("audio");
      for (let i = 0; i < generatedMedia.length; i++) {
        const media = generatedMedia[i]; setProgress(Math.round((i / generatedMedia.length) * 100));
        if (media.mediaUrl) {
          try {
            const imgResponse = await fetch(media.mediaUrl);
            const imgBlob = await imgResponse.blob();
            imageFolder?.file(`scene-${media.index}.png`, imgBlob);
          } catch (e) { console.error(e); }
        }
        if (media.audioUrl) {
          try {
            const audioResponse = await fetch(media.audioUrl);
            const audioBlob = await audioResponse.blob();
            audioFolder?.file(`scene-${media.index}.mp3`, audioBlob);
          } catch (e) { console.error(e); }
        }
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url; link.download = `pack_${Date.now()}.zip`;
      document.body.appendChild(link); link.click();
      document.body.removeChild(link); URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.message); } finally { setLoadingType('none'); }
  };

  const downloadFileSafe = async (url: string, fileName: string) => {
    try {
      const isVideo = url.includes('video') || url.includes('operations') || fileName.endsWith('.mp4');
      const apiKey = googleApiKey || process.env.API_KEY;
      const finalUrl = isVideo ? `${url}${url.includes('?') ? '&' : '?'}key=${apiKey}` : url;
      const response = await fetch(finalUrl);
      const blob = await response.blob();
      const localUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = localUrl; link.download = fileName;
      document.body.appendChild(link); link.click();
      document.body.removeChild(link); URL.revokeObjectURL(localUrl);
    } catch (e: any) { setError(e.message); }
  };

  const handleHistoryLoad = (p: SavedProject) => {
    setIntroScript(p.script); // Legacy simple load (mixes intro/body to intro)
    // Try to split coarsely if needed, or just dump into intro for now since history structure might vary
    setBodyScript("");
    setGeneratedMedia(p.media);
    setIsHistoryOpen(false);
    setCurrentStep(5);
  };

  // --- Render Steps ---

  // Step 1: Idea Generation
  const renderStep1 = () => (
    <div className="animate-in slide-in-from-right duration-500">
      <div className="bg-white rounded-[2.5rem] toss-shadow p-10 text-center mb-8">
        <span className="bg-[#e8f3ff] text-[#3182f6] px-4 py-1.5 rounded-full font-bold text-sm mb-4 inline-block tracking-wide">AI IDEATION</span>
        <h2 className="text-3xl font-black text-[#191f28] mb-4">어떤 주제로 영상을 만들까요?</h2>
        <p className="text-[#8b95a1] font-medium mb-8">YouTube에서 가장 반응이 좋을만한 아이디어 10가지를 추천해드립니다.</p>
        
        <div className="flex flex-col md:flex-row gap-4 max-w-2xl mx-auto mb-10">
          <input 
            type="text" 
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGenerateIdeas(topic)}
            placeholder="예: 미스터리, 돈 버는 법, 역사..."
            className="flex-grow p-5 bg-[#f9fafb] border border-gray-200 rounded-2xl focus:border-[#3182f6] focus:bg-white outline-none text-lg font-bold transition-all"
          />
          <Button onClick={() => handleGenerateIdeas(topic)} className="h-full py-5 px-8 rounded-2xl bg-[#3182f6] text-white text-lg font-bold shadow-lg shadow-blue-100">
            아이디어 추출
          </Button>
        </div>

        <div className="flex flex-wrap justify-center gap-3 max-w-3xl mx-auto">
          {DEFAULT_TOPICS.map((t) => (
             <button key={t} onClick={() => { setTopic(t); handleGenerateIdeas(t); }} className="px-5 py-2.5 bg-white border border-gray-200 rounded-full text-[#4e5968] font-bold hover:bg-[#f9fafb] hover:border-gray-300 transition-all text-sm">
               {t}
             </button>
          ))}
        </div>

        <div className="mt-8 pt-8 border-t border-gray-100 flex flex-col items-center">
           <p className="text-gray-400 text-sm font-medium mb-4">이미 작성된 대본이 있으신가요?</p>
           <Button 
             onClick={() => setCurrentStep(3)} 
             variant="secondary" 
             className="h-12 px-6 rounded-xl text-gray-600 font-bold bg-gray-50 hover:bg-gray-100"
             icon="📝"
           >
             대본 직접 입력하기 (Skip to Step 3)
           </Button>
        </div>
      </div>

      {ideas.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          {ideas.map((idea, idx) => (
            <div 
              key={idx} 
              onClick={() => { setSelectedIdea(idea); setCurrentStep(2); }}
              className="bg-white p-6 rounded-3xl border border-gray-100 cursor-pointer hover:border-[#3182f6] hover:shadow-xl transition-all group relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-1 h-full bg-gray-100 group-hover:bg-[#3182f6] transition-colors"></div>
              <div className="pl-4">
                <h3 className="text-lg font-black text-[#191f28] mb-2 group-hover:text-[#3182f6] transition-colors line-clamp-2">{idea.title}</h3>
                <p className="text-sm text-[#8b95a1] font-medium">{idea.hook}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // Step 2: Script Generation Preview
  const renderStep2 = () => (
    <div className="animate-in slide-in-from-right duration-500 flex flex-col items-center justify-center min-h-[50vh]">
      <div className="bg-white rounded-[2.5rem] toss-shadow p-10 max-w-2xl w-full text-center">
         <div className="w-20 h-20 bg-[#e8f3ff] text-[#3182f6] rounded-full flex items-center justify-center text-4xl mb-6 mx-auto">📝</div>
         <h2 className="text-2xl font-black text-[#191f28] mb-2">선택한 아이디어로 대본을 쓸까요?</h2>
         <div className="bg-[#f9fafb] p-6 rounded-2xl my-6 border border-gray-100">
            <h3 className="text-xl font-bold text-[#333d4b] mb-2">{selectedIdea?.title}</h3>
            <p className="text-[#8b95a1] text-sm">{selectedIdea?.hook}</p>
         </div>
         <p className="text-[#8b95a1] font-medium mb-8">약 8000자 분량의 상세 대본(Intro/Body)을 생성합니다.</p>
         <Button onClick={handleGenerateScript} fullWidth className="h-16 rounded-2xl bg-[#3182f6] text-white text-xl font-bold shadow-xl shadow-blue-100">
           대본 자동 생성 시작
         </Button>
         <button onClick={() => setCurrentStep(1)} className="mt-6 text-[#8b95a1] font-bold hover:text-[#333d4b] text-sm">
           다시 아이디어 선택하기
         </button>
      </div>
    </div>
  );

  // Step 3 (Old Step 1): Input/Edit
  const renderStep3 = () => (
    <div className="animate-in slide-in-from-right duration-500">
      <div className="grid grid-cols-1 gap-8">
        <div className="bg-white rounded-[2.5rem] toss-shadow overflow-hidden p-8">
          <div className="flex justify-between items-center mb-4">
             <h3 className="text-2xl font-black text-[#191f28]">STEP 3. 대본 확인 및 수정</h3>
             <span className="bg-[#e8f3ff] text-[#3182f6] px-4 py-1 rounded-full font-bold text-xs">INTRO & BODY</span>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-3">
              <label className="text-sm font-bold text-[#8b95a1] uppercase tracking-wider">Intro / Hook</label>
              <textarea 
                className="w-full p-6 bg-[#f9fafb] border border-gray-200 rounded-3xl focus:outline-none focus:border-[#3182f6] focus:bg-white transition-all min-h-[500px] text-lg font-medium leading-relaxed resize-none" 
                value={introScript} 
                onChange={(e) => setIntroScript(e.target.value)} 
                placeholder="자동 생성된 인트로가 여기에 표시됩니다. (또는 직접 입력)" 
              />
            </div>
            <div className="space-y-3">
              <label className="text-sm font-bold text-[#8b95a1] uppercase tracking-wider">Main Body</label>
              <textarea 
                className="w-full p-6 bg-[#f9fafb] border border-gray-200 rounded-3xl focus:outline-none focus:border-[#3182f6] focus:bg-white transition-all min-h-[500px] text-lg font-medium leading-relaxed resize-none" 
                value={bodyScript} 
                onChange={(e) => setBodyScript(e.target.value)} 
                placeholder="자동 생성된 본문이 여기에 표시됩니다. (또는 직접 입력)" 
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // Step 4 (Old Step 2): Plan Review
  const renderStep4 = () => (
    <div className="animate-in slide-in-from-right duration-500">
       <div className="bg-white rounded-[2.5rem] toss-shadow p-8 mb-8">
          <div className="flex justify-between items-center mb-6">
             <h3 className="text-2xl font-black text-[#191f28]">STEP 4. AI 연출 계획 확인</h3>
             <span className="text-sm text-[#8b95a1] font-medium">총 {generatedMedia.length}개 장면이 설계되었습니다.</span>
          </div>
          <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
            {generatedMedia.map((scene, idx) => (
              <div key={idx} className="flex gap-4 p-5 rounded-2xl border border-gray-100 bg-[#f9fafb] hover:bg-white hover:shadow-md transition-all">
                <div className="w-12 h-12 bg-[#191f28] text-white rounded-xl flex items-center justify-center font-black flex-shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-grow">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-bold text-[#3182f6] bg-[#e8f3ff] px-2 py-0.5 rounded-md">SCENE {idx + 1}</span>
                    {scene.isIntro && (
                      <span className="text-xs font-bold text-white bg-rose-500 px-2 py-0.5 rounded-md ml-1">INTRO</span>
                    )}
                  </div>
                  <p className="text-[#191f28] font-bold mb-3">{scene.originalScriptSegment}</p>
                  <div className="text-xs text-[#8b95a1] bg-white p-3 rounded-xl border border-dashed border-gray-200">
                    <span className="font-bold text-[#4e5968] block mb-1">[Visual Prompt]</span>
                    {scene.prompt}
                  </div>
                </div>
              </div>
            ))}
          </div>
       </div>
    </div>
  );

  // Step 5 (Old Step 3): Production
  const renderStep5 = () => (
    <div className="animate-in slide-in-from-right duration-500">
       <div className="flex flex-col md:flex-row justify-between items-end mb-10 gap-6">
          <div>
            <h2 className="text-4xl font-black text-[#191f28] tracking-tight">STEP 5. Production Studio</h2>
            <p className="text-[#8b95a1] font-semibold mt-2">생성된 플랜을 기반으로 이미지, 비디오, TTS를 제작합니다.</p>
          </div>
          <div className="flex gap-3">
              <Button onClick={handleStartProduction} variant="primary" className="rounded-2xl h-14 px-8 bg-[#3182f6] text-white shadow-lg shadow-blue-200 animate-pulse">
                🖼️ 이미지 전체 자동 생성
              </Button>
          </div>
       </div>
       
       <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          <div className="lg:col-span-9">
             <div className="flex flex-col space-y-5">
              {generatedMedia.map((m) => (
                <MediaCard 
                  key={m.index} 
                  media={m} 
                  onDownload={downloadFileSafe} 
                  onRegenerate={() => handleGenerateSingleImage(m.index)} 
                  onGenerateVideo={handleGenerateVideo} 
                  onGenerateTTS={handleGenerateTTS} 
                  isDisabled={false} 
                />
              ))}
             </div>
          </div>
          <div className="lg:col-span-3">
             <div className="sticky top-10 space-y-4">
                <div className="bg-white p-6 rounded-[2rem] toss-shadow">
                   <h4 className="font-bold text-[#191f28] mb-4">Batch Actions</h4>
                   <Button onClick={handleGenerateAllTTS} fullWidth variant="secondary" className="bg-[#e8f3ff] text-[#1b64da] h-14 rounded-2xl font-bold mb-3 justify-start px-6" icon="🎙️">전체 TTS 생성</Button>
                   <Button onClick={handleFinalZipDownload} fullWidth variant="primary" className="bg-[#191f28] text-white h-14 rounded-2xl font-bold justify-start px-6" icon="📦">전체 다운로드 (.zip)</Button>
                </div>
                <Button onClick={() => setShowThumbnailModal(true)} icon="🖼️" fullWidth variant="secondary" className="bg-white text-[#4e5968] h-14 rounded-2xl font-bold toss-shadow">썸네일 제작</Button>
             </div>
          </div>
       </div>
    </div>
  );

  const handleNext = () => {
    if (currentStep === 1) setCurrentStep(3); // Skip to Script Input
    else if (currentStep === 2) handleGenerateScript();
    else if (currentStep === 3) handleAnalyzeAndPlan();
    else if (currentStep === 4) handleConfirmPlan();
  };

  if (authLoading) return <div className="min-h-screen bg-[#f2f4f6] flex items-center justify-center"><div className="w-12 h-12 border-4 border-[#3182f6] border-t-transparent rounded-full animate-spin"></div></div>;
  if (!user) return <AuthPage />;

  return (
    <div className="bg-[#f2f4f6] min-h-screen pb-20">
      {/* Error Modal */}
      {error && (
        <div className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="bg-white rounded-[2rem] shadow-2xl p-10 w-full max-w-md toss-shadow text-center">
             <div className="w-16 h-16 bg-[#fff0f1] text-[#f04452] flex items-center justify-center rounded-full mx-auto mb-6 text-2xl font-bold">!</div>
             <h2 className="text-xl font-bold text-[#191f28] mb-4">서비스 이용 안내</h2>
             <div className="p-4 bg-[#f9fafb] rounded-xl mb-8 text-sm text-[#4e5968] font-medium leading-relaxed text-left max-h-[200px] overflow-y-auto">{error}</div>
             <Button onClick={() => setError(null)} className="w-full h-14 bg-[#3182f6] rounded-2xl font-bold text-lg text-white">확인</Button>
          </div>
        </div>
      )}

      {/* Loading Modal */}
      {loadingType !== 'none' && (
        <div className="fixed inset-0 z-[100] bg-black/20 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-[2.5rem] shadow-2xl p-10 w-full max-w-lg toss-shadow text-center">
            <div className="flex flex-col items-center">
              <div className="w-16 h-16 border-4 border-[#3182f6] border-t-transparent rounded-full animate-spin mb-6"></div>
              <h2 className="text-2xl font-bold text-[#191f28] mb-2 uppercase">
                {loadingType === 'ideas' ? '아이디어 발굴 중' :
                 loadingType === 'script' ? '대본 작성 중' :
                 loadingType === 'planning' ? '대본 분석 및 설계 중' : 
                 loadingType === 'single_image' ? '개별 작업 처리 중' : 
                 loadingType === 'image' ? '이미지 일괄 생성 중' : '콘텐츠 생성 중'}
              </h2>
              <p className="text-[#4e5968] font-medium mb-8">{loadingStatus}</p>
              {loadingType !== 'ideas' && loadingType !== 'script' && loadingType !== 'planning' && loadingType !== 'single_image' && (
                <div className="w-full bg-[#f2f4f6] h-3 rounded-full overflow-hidden mb-8">
                  <div className="bg-[#3182f6] h-full transition-all duration-500 rounded-full" style={{ width: `${progress}%` }}></div>
                </div>
              )}
              <Button onClick={() => abortControllerRef.current?.abort()} variant="danger" className="w-full h-14 rounded-2xl font-bold bg-[#feeef0] text-[#f04452]">작업 취소</Button>
            </div>
          </div>
        </div>
      )}

      {/* Main Layout */}
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-12">
        <header className="flex flex-col md:flex-row justify-between items-center mb-12 gap-6 bg-white p-6 rounded-[2rem] toss-shadow">
          <div className="text-left flex items-center gap-4">
            <div>
              <h1 className="text-2xl font-black text-[#191f28] tracking-tight leading-none">YouTube <span className="text-[#3182f6]">Automation</span></h1>
              <p className="text-xs text-[#8b95a1] font-bold mt-1 uppercase tracking-wide">Step {currentStep} of 5</p>
            </div>
          </div>
          
          <div className="flex gap-4 items-center">
             {currentStep > 1 && (
               <Button onClick={() => setCurrentStep(prev => prev - 1)} variant="secondary" icon="⬅️" className="rounded-xl h-12 bg-[#f2f4f6] text-[#4e5968] font-bold">
                 Previous
               </Button>
             )}
             
             {currentStep < 5 && (
               <Button onClick={handleNext} variant="primary" icon="➡️" className="rounded-xl h-12 bg-[#3182f6] text-white font-bold px-6 shadow-lg shadow-blue-100">
                 Next Step
               </Button>
             )}

             <div className="w-px h-8 bg-gray-200 mx-2"></div>

             <Button onClick={() => setShowSettings(true)} variant="secondary" icon="⚙️" className="rounded-xl h-12 bg-white border border-gray-100 text-[#4e5968] font-bold" />
             <Button onClick={async () => { setHistoryProjects(await getProjects()); setIsHistoryOpen(true); }} variant="secondary" icon="📂" className="rounded-xl h-12 bg-white border border-gray-100 text-[#4e5968] font-bold" />
             <Button onClick={handleLogout} variant="secondary" className="rounded-xl h-12 bg-white border border-gray-100 text-[#f04452] font-bold px-4 hover:bg-red-50 hover:border-red-100">로그아웃</Button>
          </div>
        </header>

        <ApiKeyModal isOpen={showSettings} onClose={() => setShowSettings(false)} elevenLabsKey={elevenLabsKey} setElevenLabsKey={setElevenLabsKey} elevenLabsVoiceId={voiceId} setElevenLabsVoiceId={setVoiceId} googleApiKey={googleApiKey} setGoogleApiKey={setGoogleApiKey} />
        <HistoryModal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} projects={historyProjects} onLoad={handleHistoryLoad} onDelete={async (id) => { await deleteProject(id); setHistoryProjects(await getProjects()); }} />
        <ThumbnailModal isOpen={showThumbnailModal} onClose={() => setShowThumbnailModal(false)} script={introScript + " " + bodyScript} onGenerateText={(script) => generateThumbnailText(script, googleApiKey)} />

        {currentStep === 1 && renderStep1()}
        {currentStep === 2 && renderStep2()}
        {currentStep === 3 && renderStep3()}
        {currentStep === 4 && renderStep4()}
        {currentStep === 5 && renderStep5()}
      </div>
    </div>
  );
};

export default App;
