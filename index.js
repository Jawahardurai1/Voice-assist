// server/index.js
// Updated server: Node.js + Express + WebSocket proxy to Gemini Live.
// Usage:
// 1) copy .env.example to .env and set GEMINI_API_KEY
// 2) npm install
// 3) npm start
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import pkg from "wavefile";
const { WaveFile } = pkg;
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Please set GEMINI_API_KEY in .env or environment");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function pcm16ToWavBuffer(int16Array, sampleRate = 24000) {
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, "16", Int16Array.from(int16Array));
  return Buffer.from(wav.toBuffer());
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

wss.on("connection", async (ws) => {
  console.log("Client connected");

  const model = process.env.GEMINI_MODEL || "gemini-live-2.5-flash-preview";
  const config = {
    responseModalities: ["AUDIO"],
    systemInstruction: process.env.SYSTEM_INSTRUCTION || "You are Rev, the voice assistant for Revolt Motors. Only answer questions about Revolt Motors. Keep replies concise and helpful."
  };

  let session;
  try {
    session = await ai.live.connect({
      model,
      callbacks: {
        onopen: () => console.log("Connected to Gemini Live"),
        onmessage: (message) => {
          try {
            const parsed = message;
            if (parsed?.data) {
              // parsed.data is base64 PCM16 (assumed 24000Hz)
              const pcmBuffer = Buffer.from(parsed.data, "base64");
              const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.byteLength/2));
              const wavBuffer = pcm16ToWavBuffer(int16, 24000);
              const wavB64 = wavBuffer.toString("base64");
              ws.send(JSON.stringify({ type: "audio", data: wavB64 }));
            }

            if (parsed?.serverContent?.modelTurn?.parts) {
              const parts = parsed.serverContent.modelTurn.parts;
              const texts = parts.map(p => (p.inlineData && p.inlineData.text) ? p.inlineData.text : "").filter(Boolean);
              if (texts.length) {
                ws.send(JSON.stringify({ type: "transcript", text: texts.join("\n") }));
              }
            }

            if (parsed?.serverContent?.turnComplete) {
              ws.send(JSON.stringify({ type: "turnComplete" }));
            }
          } catch (err) {
            console.error("Forward error:", err);
          }
        },
        onerror: (e) => {
          console.error("Gemini error:", e);
          ws.send(JSON.stringify({ type: "error", error: String(e) }));
        },
        onclose: (e) => {
          console.log("Gemini closed:", e?.reason || "close");
        }
      },
      config,
    });
    console.log("Gemini session created with model:", model);
  } catch (err) {
    console.error("Failed to create session:", err);
    ws.send(JSON.stringify({ type: "error", error: "Failed to connect to Gemini Live API" }));
    ws.close();
    return;
  }

  ws.on("message", async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === "audio" && session) {
        // forward base64 PCM16 at 16000Hz to Gemini Live
        await session.sendRealtimeInput({
          audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" }
        });
      } else if (msg.type === "stop" && session) {
        try {
          if (typeof session.stopCurrentTurn === "function") {
            await session.stopCurrentTurn();
          } else if (typeof session.closeTurn === "function") {
            await session.closeTurn();
          }
        } catch (err) {
          console.warn("Interruption call failed:", err);
        }
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (err) {
      console.error("Handle message failed:", err);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    try { session?.close(); } catch (e) {}
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
});

app.get("/", (req, res) => res.send("Gemini Live proxy running"));
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
