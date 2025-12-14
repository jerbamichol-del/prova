// src/components/VoiceInputModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Expense } from '../types';
import { parseExpenseFromAudio } from '../utils/ai';
import { XMarkIcon } from './icons/XMarkIcon';
import { MicrophoneIcon } from './icons/MicrophoneIcon';

interface VoiceInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onParsed: (data: Partial<Omit<Expense, 'id'>>) => void;
}

type Status = 'idle' | 'listening' | 'processing' | 'error';

const VoiceInputModal: React.FC<VoiceInputModalProps> = ({
  isOpen,
  onClose,
  onParsed,
}) => {
  const [isAnimating, setIsAnimating] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Registrazione audio
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  
  // Ref per tracciare se l'utente ha annullato l'operazione
  const isCancelledRef = useRef(false);

  // Visualizzazione onda
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const visualizerBarRef = useRef<HTMLDivElement | null>(null);

  const stopVisualization = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current = null;
    dataArrayRef.current = null;
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
  };

  const cleanUp = () => {
    try {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        mediaRecorderRef.current.stop();
      }
    } catch (e) {
      console.warn('Errore nello stop del MediaRecorder:', e);
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }

    mediaRecorderRef.current = null;
    streamRef.current = null;
    // NON resettare chunksRef qui se stiamo processando, 
    // altrimenti onstop potrebbe trovarsi senza dati
    
    stopVisualization();
  };

  const startVisualization = async (stream: MediaStream) => {
    try {
      const AudioContextCtor =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextCtor) {
        console.warn('AudioContext non supportato: niente visualizzazione onda.');
        return;
      }

      const audioCtx = new AudioContextCtor();
      audioContextRef.current = audioCtx;

      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch {
          // può fallire su alcune policy, pazienza
        }
      }

      const sourceNode = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      sourceNode.connect(analyser);

      analyserRef.current = analyser;
      const bufferLength = analyser.frequencyBinCount;
      dataArrayRef.current = new Uint8Array(bufferLength);

      const visualize = () => {
        if (
          !analyserRef.current ||
          !dataArrayRef.current ||
          !visualizerBarRef.current
        ) {
          return;
        }

        analyserRef.current.getByteTimeDomainData(dataArrayRef.current);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArrayRef.current[i];
          sum += Math.abs(v - 128);
        }
        const amplitude = sum / bufferLength / 128; // ~0–1
        const scale = 0.2 + amplitude * 1.8; // minimo 0.2, max ~2.0

        visualizerBarRef.current.style.transform = `scaleY(${scale})`;

        animationFrameRef.current = requestAnimationFrame(visualize);
      };

      visualize();
    } catch (e) {
      console.warn('Errore inizializzando la visualizzazione audio:', e);
    }
  };

  const startRecording = async () => {
    setError(null);
    setTranscript('');
    isCancelledRef.current = false; 
    chunksRef.current = []; // Reset chunks all'avvio

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Preferisci codecs standard ma con fallback
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4'; // Safari supporta meglio mp4
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Se l'utente ha annullato, esci subito
        if (isCancelledRef.current) return;

        // Se non ci sono dati, mostra errore
        if (chunksRef.current.length === 0) {
            console.error('[Voice] Nessun dato audio registrato');
            setError('Nessun audio rilevato. Riprova.');
            setStatus('error');
            return;
        }

        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        setStatus('processing');

        // Timeout di sicurezza per l'analisi AI (15 secondi)
        const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Timeout analisi')), 15000)
        );

        try {
          // Race tra l'analisi e il timeout
          const parsed = await Promise.race([
              parseExpenseFromAudio(audioBlob),
              timeoutPromise
          ]);

          if (isCancelledRef.current) return;

          console.log('[Voice] Risultato AI:', parsed);

          if (!parsed) {
             throw new Error('Risposta vuota dall\'AI');
          }

          if (
            (parsed.amount !== undefined && !Number.isNaN(parsed.amount)) ||
            parsed.description
          ) {
            setTranscript(parsed.description || '');
            onParsed({
              description: parsed.description || '',
              amount: typeof parsed.amount === 'number' ? parsed.amount : undefined,
              category: (parsed.category as string) || undefined,
            });
            // onParsed chiuderà il modale, quindi non serve fare altro qui
          } else {
            setError(
              'Non ho capito. Prova: "20 euro per benzina".'
            );
            setStatus('error');
          }
        } catch (e: any) {
          if (isCancelledRef.current) return;
          console.error('[Voice] Errore analisi:', e);
          
          let errorMsg = "Errore durante l'analisi.";
          if (e.message === 'Timeout analisi') {
              errorMsg = "L'analisi sta impiegando troppo tempo. Riprova.";
          } else if (e.message?.includes('Network')) {
              errorMsg = "Errore di connessione. Controlla internet.";
          }

          setError(errorMsg);
          setStatus('error');
        } finally {
          // Pulizia finale solo dopo aver finito tutto
          chunksRef.current = [];
        }
      };

      mediaRecorder.start();
      setStatus('listening');

      await startVisualization(stream);
    } catch (err) {
      console.error('[Voice] Accesso microfono fallito:', err);
      setError(
        'Accesso al microfono negato o non supportato.'
      );
      setStatus('error');
    }
  };

  const handleStopClick = () => {
    if (status !== 'listening') return;

    // Ferma il recorder -> questo triggera onstop
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording'
    ) {
      mediaRecorderRef.current.stop();
    }
    
    // Ferma subito lo stream e la visualizzazione per feedback immediato
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    stopVisualization();
  };

  const handleClose = () => {
    isCancelledRef.current = true;
    cleanUp();
    setStatus('idle');
    setError(null);
    setTranscript('');
    onClose();
  };

  // Avvio automatico
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => setIsAnimating(true), 10);
      startRecording();

      return () => {
        clearTimeout(timer);
        isCancelledRef.current = true;
        cleanUp();
      };
    } else {
      setIsAnimating(false);
      setStatus('idle');
      setError(null);
      setTranscript('');
      isCancelledRef.current = true;
      cleanUp();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const getStatusContent = () => {
    switch (status) {
      case 'listening':
        return {
          icon: (
            <button
              type="button"
              onClick={handleStopClick}
              className="relative w-28 h-28 flex items-center justify-center focus:outline-none touch-manipulation"
              aria-label="Termina registrazione e analizza"
            >
              <div className="absolute inset-0 rounded-full bg-red-500/30 animate-ping" />
              <div className="relative w-24 h-24 rounded-full bg-red-500 flex items-center justify-center shadow-lg transform transition-transform active:scale-95">
                <MicrophoneIcon className="w-12 h-12 text-white" />
              </div>
              <div className="absolute -right-6 h-20 w-3 rounded-full bg-red-200 overflow-hidden flex items-end">
                <div
                  ref={visualizerBarRef}
                  className="w-full bg-red-600 origin-bottom transition-transform duration-75"
                  style={{ transform: 'scaleY(0.2)' }}
                />
              </div>
            </button>
          ),
          text: 'In ascolto...',
          subtext: 'Tocca il cerchio rosso per terminare.',
        };
      case 'processing':
        return {
          icon: (
            <div className="w-24 h-24 rounded-full bg-indigo-500 flex items-center justify-center shadow-lg">
              <div className="w-12 h-12 animate-spin rounded-full border-4 border-t-transparent border-white" />
            </div>
          ),
          text: 'Elaborazione...',
          subtext: 'Sto analizzando la tua spesa...',
        };
      case 'error':
        return {
          icon: (
            <div className="w-24 h-24 rounded-full bg-red-100 flex items-center justify-center shadow-sm">
              <XMarkIcon className="w-12 h-12 text-red-500" />
            </div>
          ),
          text: 'Errore',
          subtext: error || 'Qualcosa è andato storto.',
        };
      default:
        return { icon: null, text: '', subtext: '' };
    }
  };

  const { icon, text, subtext } = getStatusContent();

  return (
    <div
      className={`fixed inset-0 z-[6000] flex justify-center items-center p-4 transition-opacity duration-300 ease-in-out ${
        isAnimating ? 'opacity-100' : 'opacity-0'
      } bg-slate-900/60 backdrop-blur-sm`}
      onClick={handleClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full max-w-sm transform transition-all duration-300 ease-in-out ${
          isAnimating ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">Aggiungi con Voce</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 transition-colors p-2 rounded-full hover:bg-slate-100"
            aria-label="Chiudi"
          >
            <XMarkIcon className="w-6 h-6" />
          </button>
        </div>

        <div className="p-8 flex flex-col items-center justify-center min-h-[280px] text-center">
          {icon}
          
          <div className="mt-6 space-y-1">
            <p className="text-xl font-bold text-slate-800">{text}</p>
            <p className="text-sm text-slate-500 max-w-[200px] mx-auto leading-relaxed">{subtext}</p>
          </div>

          {status === 'error' && (
            <button
              type="button"
              onClick={startRecording}
              className="mt-6 px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-semibold shadow-md hover:bg-indigo-700 active:scale-95 transition-all"
            >
              Riprova
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default VoiceInputModal;