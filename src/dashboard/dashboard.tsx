import { useState } from "react";
import RunboxManager from "./components/RunboxManager";
import { useStackbox } from "./useStackbox";

const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: #121212; font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
  button { font-family: 'Inter', sans-serif; }
  button:focus { outline: none; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
`;

export default function App() {
  const data = useStackbox();

  return (
    <>
      <style>{globalStyles}</style>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#121212" }}>
        <RunboxManager        />
      </div>
    </>
  );
}