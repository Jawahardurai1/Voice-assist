import React, { useEffect, useRef, useState } from 'react';
const WS_SERVER = import.meta.env.VITE_WS_SERVER || 'ws://localhost:3001';

export default function VoiceChat(){
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState('idle'); // idle, listening, speaking, processing
  const [transcript, setTranscript] = useState('');
  const [messages, setMessages] = useState([]);
  const [muted, setMuted] = useState(false);

  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const procRef = useRef(null);
  const streamRef = useRef(null);
  const playingAudioRef = useRef(null);

  async function connect(){
    setConnected(false);
    const ws = new WebSocket(WS_SERVER);
    wsRef.current = ws;
    ws.onopen = ()=>{ setConnected(true); console.log('ws open')};
    ws.onmessage = (ev)=> {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'audio' && d.data) {
          playBase64Wav(d.data);
        } else if (d.type === 'transcript') {
          setTranscript(d.text || '');
        } else if (d.type === 'turnComplete') {
          setState('idle');
        } else if (d.type === 'error') {
          console.error('server error', d.error);
        }
      } catch (e){ console.error(e) }
    };
    ws.onclose = ()=> setConnected(false);
    ws.onerror = (e)=> console.error('ws err', e);
  }

  async function startCapture(){
    if (!connected) return;
    setState('listening');
    setTranscript('Listening...');
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    streamRef.current = stream;
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;
    const proc = audioCtx.createScriptProcessor(4096,1,1);
    procRef.current = proc;
    source.connect(proc);
    proc.connect(audioCtx.destination);
    proc.onaudioprocess = (e)=> {
      if (muted || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const data = e.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16k(data, audioCtx.sampleRate);
      const b64 = int16ToBase64(pcm16);
      wsRef.current.send(JSON.stringify({ type:'audio', data: b64 }));
    };
  }

  function stopCapture(){
    setState('processing');
    setTranscript('Processing...');
    try {
      procRef.current?.disconnect();
      sourceRef.current?.disconnect();
      streamRef.current?.getTracks().forEach(t=>t.stop());
      audioCtxRef.current?.close();
    } catch(e){}
    procRef.current = null; sourceRef.current = null; streamRef.current = null; audioCtxRef.current = null;
  }

  function downsampleTo16k(buffer, srcRate){
    if (srcRate === 16000) {
      const out = new Int16Array(buffer.length);
      for (let i=0;i<buffer.length;i++){
        const s = Math.max(-1, Math.min(1, buffer[i]));
        out[i] = s < 0 ? s*0x8000 : s*0x7fff;
      }
      return out;
    }
    const ratio = srcRate / 16000;
    const newLen = Math.round(buffer.length / ratio);
    const res = new Int16Array(newLen);
    let offsetRes = 0, offsetBuff = 0;
    while (offsetRes < newLen) {
      const next = Math.round((offsetRes+1)*ratio);
      let acc=0, cnt=0;
      for (let i=offsetBuff;i<next && i<buffer.length;i++){ acc+=buffer[i]; cnt++; }
      const avg = acc / Math.max(cnt,1);
      const s = Math.max(-1, Math.min(1, avg));
      res[offsetRes] = s<0 ? s*0x8000 : s*0x7fff;
      offsetRes++; offsetBuff = next;
    }
    return res;
  }

  function int16ToBase64(int16){
    const u8 = new Uint8Array(int16.buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i=0;i<u8.length;i+=chunk){
      binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i,i+chunk)));
    }
    return btoa(binary);
  }

  function playBase64Wav(b64){
    if (muted) return;
    stopPlayback();
    const audio = new Audio('data:audio/wav;base64,'+b64);
    playingAudioRef.current = audio;
    audio.onended = ()=> setState('idle');
    audio.play().catch(e=>{ console.error('play fail', e); setState('idle'); });
    setState('speaking');
  }

  function stopPlayback(){
    if (playingAudioRef.current){
      try { playingAudioRef.current.pause(); playingAudioRef.current.currentTime = 0; } catch(e){}
      playingAudioRef.current = null;
    }
  }

  async function micButton(){
    if (!connected) return;
    if (state === 'idle') {
      stopPlayback();
      await startCapture();
    } else if (state === 'listening') {
      stopCapture();
    } else if (state === 'speaking') {
      // interrupt
      stopPlayback();
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type:'stop' }));
      }
      await startCapture();
    }
  }

  function toggleMute(){ setMuted(m=>!m); if (!muted) stopPlayback(); }

  useEffect(()=>{ return ()=>{ try{ wsRef.current?.close(); stopCapture(); stopPlayback(); }catch(e){} } },[]);

  return (
    <div>
      <div className="header">
        <div style={{flex:1}}>
          <div className="small">Status: {connected ? 'Connected' : 'Disconnected'}</div>
          <div className="small">State: {state}</div>
        </div>
        <div>
          <button onClick={connect} disabled={connected} style={{marginRight:8}}>Connect</button>
          <button className={'mic-btn '+(state==='listening'?'listening':'')} onClick={micButton} disabled={!connected}>
            {state==='idle' ? '🎤' : state==='listening' ? '⏹' : '✋'}
          </button>
          <button onClick={toggleMute} style={{marginLeft:8}}>{muted ? 'Unmute' : 'Mute'}</button>
        </div>
      </div>

      <div className="controls small">
        <div className="status-row">
          <div>Transcript:</div><div style={{marginLeft:8, color:'#0f172a'}}>{transcript}</div>
        </div>
      </div>

      <div className="chat">
        {messages.map((m,i)=>(
          <div key={i} className={'bubble '+(m.from==='ai'?'ai':'user')}>{m.text}</div>
        ))}
      </div>
    </div>
  );
}
