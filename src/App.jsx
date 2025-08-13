import React from 'react';
import VoiceChat from './components/VoiceChat';
export default function App(){ return (
  <div className="container">
    <h1>Rev Voice — Gemini Live</h1>
    <p>Demo: interruption + low-latency streaming. Default voice: en-US.</p>
    <VoiceChat />
  </div>
); }
