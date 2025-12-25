import { useEffect, useMemo, useRef, useState } from "react";

const CONFIG = {
  geminiModel: "gemini-2.5-flash-preview-09-2025",
  imagenModel: "imagen-4.0-fast-generate-001",
  apiBase: "https://generativelanguage.googleapis.com/v1beta/models/",
  maxImageDimension: 1600,
};

const initialChatLogs = [
  {
    sender: "system",
    text: "鑑定結果についてさらに詳しく質問できます。",
  },
];

const VIEWS = {
  INPUT: "input",
  LOADING: "loading",
  RESULT: "result",
};

const apiKey = (import.meta.env.VITE_GOOGLE_API_KEY || "").trim();

const escapeHtml = (str = "") =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function renderSafeMarkdown(md = "") {
  const safe = escapeHtml(md);
  return safe
    .replace(/^# (.*$)/gm, '<h2 class="text-2xl font-black mb-4">$1</h2>')
    .replace(/^(\d\.\s\*\*(.*?)\*\*)/gm, "<h3>$2</h3>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[*-] (.*)/gm, "<li>$1</li>")
    .split("\n\n")
    .map((p) => {
      if (p.includes("<li>")) return `<ul class="space-y-1 mb-4">${p}</ul>`;
      return `<p class="mb-4">${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function compressAndResizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > CONFIG.maxImageDimension) {
            height *= CONFIG.maxImageDimension / width;
            width = CONFIG.maxImageDimension;
          }
        } else if (height > CONFIG.maxImageDimension) {
          width *= CONFIG.maxImageDimension / height;
          height = CONFIG.maxImageDimension;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const compressedBase64 = canvas.toDataURL("image/jpeg", 0.8);
        resolve(compressedBase64);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function ensureApiKey() {
  if (!apiKey) {
    throw new Error("APIキーが設定されていません。VITE_GOOGLE_API_KEY を設定してください。");
  }
  return apiKey;
}

async function secureApiCall(payload, endpoint = "generateContent", retries, delay = 2000, options = {}) {
  const { onQuota } = options;
  const key = ensureApiKey();
  const isPredict = endpoint === "predict";
  const model = isPredict ? CONFIG.imagenModel : CONFIG.geminiModel;
  const url = `${CONFIG.apiBase}${model}:${endpoint}?key=${key}`;
  const remainingRetries = typeof retries === "number" ? retries : isPredict ? 0 : 2;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const rawMessage = errorData.error?.message || `HTTP ${response.status}`;
      const lower = rawMessage.toLowerCase();
      const status = response.status;
      const isQuota =
        status === 429 ||
        status === 403 ||
        lower.includes("quota") ||
        lower.includes("exceed") ||
        lower.includes("exhausted") ||
        lower.includes("insufficient tokens") ||
        lower.includes("billing") ||
        lower.includes("billed users") ||
        lower.includes("daily limit");

      // 429は指数バックオフでリトライ
      if (status === 429 && remainingRetries > 0) {
        await new Promise((res) => setTimeout(res, delay));
        return secureApiCall(payload, endpoint, remainingRetries - 1, delay * 2, options);
      }

      // その他のエラーはモーダルを出して中断
      if (isQuota) {
        onQuota?.();
        throw new Error("無料枠を使い切ったため、本日はご利用いただけません。明日以降か、課金設定後にお試しください。");
      }
      const isBillingRequired =
        lower.includes("billed users") ||
        lower.includes("billing account") ||
        lower.includes("billing required") ||
        lower.includes("enable billing");
      if (isBillingRequired) {
        throw new Error("Imagenは現在有料アカウント専用です。Google AI Studioで課金設定を有効にすると精霊生成が利用できます。");
      }
      throw new Error(rawMessage);
    }

    return await response.json();
  } catch (error) {
    // ネットワーク例外などで429以外でもリトライしたい場合はここで拾う
    if (!isPredict && remainingRetries > 0 && error?.status === 429) {
      await new Promise((res) => setTimeout(res, delay));
      return secureApiCall(payload, endpoint, remainingRetries - 1, delay * 2, options);
    }
    throw error;
  }
}

function App() {
  const fileInputRef = useRef(null);
  const [view, setView] = useState(VIEWS.INPUT);
  const [modalOpen, setModalOpen] = useState(true);
  const [imagePreview, setImagePreview] = useState("");
  const [imageData, setImageData] = useState("");
  const [imageMime, setImageMime] = useState("image/jpeg");
  const [userName, setUserName] = useState("");
  const [analysisMarkdown, setAnalysisMarkdown] = useState("");
  const [loadingText, setLoadingText] = useState("解析中...");
  const [isProcessing, setIsProcessing] = useState(false);
  const [spiritState, setSpiritState] = useState({ status: "idle", img: "", caption: "" });
  const [chatLogs, setChatLogs] = useState(() => [...initialChatLogs]);
  const [chatInput, setChatInput] = useState("");
  const [toast, setToast] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const [quotaModal, setQuotaModal] = useState(false);

  const displayName = useMemo(() => userName.trim() || "あなた", [userName]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [view]);

  const showToast = (message) => setToast(message);

  const handleImageSelection = async (file) => {
    if (!file || !file.type.startsWith("image/")) {
      showToast("画像ファイルを選択してください");
      return;
    }

    try {
      const compressedDataUrl = await compressAndResizeImage(file);
      setImagePreview(compressedDataUrl);
      setImageData(compressedDataUrl.split(",")[1]);
      setImageMime("image/jpeg");
    } catch (err) {
      console.error("Image processing error:", err);
      showToast("画像の処理に失敗しました");
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDropActive(false);
    const [file] = event.dataTransfer.files || [];
    handleImageSelection(file);
  };


  const startAnalysis = async () => {
    if (!imageData || isProcessing) {
      showToast("手のひらの画像をアップロードしてください");
      return;
    }

    setIsProcessing(true);
    setLoadingText(`${displayName}さんの未来を解読中...`);
    setView(VIEWS.LOADING);

    const prompt = `あなたは世界最高峰の手相鑑定士です。添付された画像を深く分析してください。
対象者は「${displayName}」さんです。
以下の項目でレポートを作成してください（Markdown形式）：
1. **全体的な印象**: 基本的な資質。
2. **主要な線の解読**: 生命線、知能線、感情線の状態。
3. **掌丘とサイン**: 手の特徴。
4. **AIからの助言**: 3つの助言。
鑑定結果の文中で必ず「${displayName}さん」と呼びかけてください。`;

    try {
      const response = await secureApiCall(
        {
          contents: [
            {
              parts: [
                { text: prompt },
                { inlineData: { mimeType: imageMime, data: imageData } },
              ],
            },
          ],
        },
        "generateContent",
        undefined,
        undefined,
        { onQuota: () => setQuotaModal(true) }
      );

      const content = response?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error("解析結果が得られませんでした");

      setAnalysisMarkdown(content);
      setView(VIEWS.RESULT);
      setSpiritState({ status: "idle", img: "", caption: "" });
    } catch (error) {
      console.error("Analysis Error:", error);
      setAnalysisMarkdown("");
      const msg = error?.message || "";
      const lower = msg.toLowerCase();
      const isQuota =
        lower.includes("無料枠を使い切った") ||
        lower.includes("quota") ||
        lower.includes("exceed") ||
        lower.includes("exhausted") ||
        lower.includes("insufficient tokens") ||
        lower.includes("billing") ||
        lower.includes("billed users") ||
        lower.includes("daily limit");
      if (isQuota) {
        setQuotaModal(true);
      }
      showToast(msg || "鑑定に失敗しました。時間をおいて再試行してください。");
      setView(VIEWS.INPUT);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSummonSpirit = () => {
    if (!analysisMarkdown) {
      showToast("先に鑑定を完了してください");
      return;
    }
    generateSpirit();
  };

  const fetchFallbackImage = async (prompt) => {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      `Mystical ethereal fantasy spirit, ${prompt}, detailed spiritual digital art, cinematic lighting`
    )}?width=1024&height=1024&nologo=true&seed=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("代替画像サービスでも生成に失敗しました");
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const generateSpirit = async () => {
    if (!analysisMarkdown) {
      showToast("先に鑑定を完了してください");
      return;
    }
    setSpiritState({ status: "loading", img: "", caption: "" });

    let promptText = "";
    let spiritName = "精霊";

    try {
      const promptRes = await secureApiCall(
        {
          contents: [
            {
              parts: [
                {
                  text: `以下の手相鑑定結果から${displayName}さんの魂を象徴する幻想的な守護精霊を1体定義し、Imagen 4.0用英語プロンプトと和名をカッコ内に。結果：${analysisMarkdown.substring(
                    0,
                    1000
                  )}`,
                },
              ],
            },
          ],
        },
        "generateContent",
        undefined,
        undefined,
        { onQuota: () => setQuotaModal(true) }
      );

      const raw = promptRes?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      promptText = raw.split("(")[0].trim();
      spiritName = raw.match(/\((.*?)\)/)?.[1] || "精霊";

      const fallbackImg = await fetchFallbackImage(promptText || analysisMarkdown.substring(0, 200));

      setSpiritState({
        status: "done",
        img: fallbackImg,
        caption: `召喚された精霊：${spiritName}`,
      });
    } catch (error) {
      console.error("Summon Error:", error);
      const msg = error?.message || "";
      showToast(msg || "精霊の召喚に失敗しました");
      setSpiritState({ status: "idle", img: "", caption: "" });
    }
  };

  const handleChat = async () => {
    const query = chatInput.trim();
    if (!query || !analysisMarkdown) return;

    const userLog = { sender: "user", text: query };
    const thinkingLog = { sender: "bot", text: "考察中..." };
    setChatLogs((logs) => [...logs, userLog, thinkingLog]);
    setChatInput("");

    try {
      const response = await secureApiCall(
        {
          contents: [
            {
              role: "user",
              parts: [{ text: `手相鑑定結果：\n${analysisMarkdown}\n\n質問：${query}` }],
            },
          ],
        },
        "generateContent",
        undefined,
        undefined,
        { onQuota: () => setQuotaModal(true) }
      );
      const answer = response?.candidates?.[0]?.content?.parts?.[0]?.text || "お答えを生成できませんでした。";
      setChatLogs((logs) => [...logs.slice(0, -1), { sender: "bot", text: answer }]);
    } catch (error) {
      console.error("Chat Error:", error);
      setChatLogs((logs) => [...logs.slice(0, -1), { sender: "bot", text: "お答えを生成できませんでした。" }]);
    }
  };

  const handleCopy = async () => {
    if (!analysisMarkdown) return;
    try {
      await navigator.clipboard.writeText(analysisMarkdown);
      showToast("鑑定結果をコピーしました");
    } catch {
      showToast("コピーに失敗しました");
    }
  };

  const resetApp = () => {
    setImagePreview("");
    setImageData("");
    setImageMime("image/jpeg");
    setUserName("");
    setAnalysisMarkdown("");
    setSpiritState({ status: "idle", img: "", caption: "" });
    setChatLogs([...initialChatLogs]);
    setChatInput("");
    setView(VIEWS.INPUT);
    setIsProcessing(false);
    setQuotaModal(false);
  };

  return (
    <div className="p-4 md:p-8 flex flex-col items-center min-h-screen">
      {modalOpen && (
        <div className="modal-overlay">
          <div className="glass-card max-w-lg w-full p-8 md:p-10 shadow-2xl fade-in">
            <h2 className="text-2xl font-black text-white mb-4 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              実践的なアドバイス
            </h2>
            <div className="space-y-4 text-sm text-slate-300 mb-8 leading-relaxed text-left">
              <p>このアプリを安全に、かつプロフェッショナルに利用するための推奨事項です。</p>
              <p>
                <strong>指先を写さない:</strong> 鑑定に必要なのは「手のひら」中央の線です。指紋部分はフレームの外に出して撮影することを推奨します。
              </p>
              <p>
                <strong>背景に配慮する:</strong> 自身の顔や住所がわかるものが写り込まないようにしてください。
              </p>
              <p>
                <strong>匿名性の保持:</strong> お名前はニックネーム等でも構いません。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-black rounded-xl transition-all shadow-lg active:scale-95"
            >
              同意して開始する
            </button>
          </div>
        </div>
      )}

      <header className="text-center mb-10 fade-in w-full max-w-full overflow-hidden">
        <h1 className="text-3xl md:text-5xl font-black bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 mb-3 tracking-tight">
          AI お手を拝借 Pro
        </h1>
        <p className="text-indigo-200 opacity-70 text-sm md:text-lg px-2 text-center">Geminiが導き出す、科学と神秘の融合</p>
      </header>

      {view === VIEWS.INPUT && (
        <section className="w-full max-w-3xl space-y-8 fade-in">
          <div className="glass-card p-6 md:p-12 text-center shadow-2xl">
            {!imagePreview && (
              <div
                className={`border-2 border-dashed border-indigo-500/30 rounded-2xl p-6 md:p-10 transition-all hover:border-indigo-400 cursor-pointer mb-6 group ${
                  dropActive ? "bg-indigo-500/10" : ""
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropActive(true);
                }}
                onDragLeave={() => setDropActive(false)}
                onDrop={handleDrop}
              >
                <div className="flex flex-col items-center">
                  <div className="w-16 h-16 bg-indigo-500/10 rounded-full flex items-center justify-center mb-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8-4-4m0 0L8 8m4-4v12" />
                    </svg>
                  </div>
                  <p className="text-lg font-bold text-white mb-1">手のひらの画像をアップロード</p>
                  <p className="text-xs text-slate-400">クリックして選択、またはドラッグ＆ドロップ</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleImageSelection(e.target.files?.[0])}
                />
              </div>
            )}

            {imagePreview && (
              <div className="space-y-6">
                <div className="relative inline-block max-w-full">
                  <img src={imagePreview} className="max-h-64 md:max-h-72 w-auto mx-auto rounded-xl shadow-2xl border-2 border-indigo-500/20" alt="Preview" />
                  <button
                    type="button"
                    onClick={() => {
                      setImagePreview("");
                      setImageData("");
                    }}
                    className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1.5 shadow-lg"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>

                <div className="max-w-xs mx-auto text-left space-y-2">
                  <label className="text-indigo-200 text-xs font-bold ml-1">お名前（任意）</label>
                  <input
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value.slice(0, 20))}
                    placeholder="例：ひなた"
                    className="w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    maxLength={20}
                  />
                </div>

                <button
                  type="button"
                  onClick={startAnalysis}
                  disabled={isProcessing}
                  className="w-full max-w-xs mx-auto py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-all shadow-xl active:scale-95 disabled:opacity-60"
                >
                  運命を解読する
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {view === VIEWS.LOADING && (
        <section className="w-full max-w-3xl glass-card p-12 md:p-16 flex flex-col items-center justify-center space-y-6">
          <div className="loader" />
          <div className="text-center">
            <p className="text-2xl font-bold text-indigo-100">{loadingText}</p>
            <p className="text-slate-400 mt-2">AIが宇宙の理を読み解いています</p>
          </div>
        </section>
      )}

      {view === VIEWS.RESULT && (
        <section className="w-full max-w-3xl space-y-8 fade-in">
          <div className="glass-card p-6 md:p-12 shadow-2xl">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 border-b border-white/10 pb-6 gap-4">
              <div>
                <h2 className="text-2xl font-black text-white">{`${displayName}さんの鑑定書`}</h2>
                <p className="text-indigo-400 text-xs tracking-widest uppercase">Professional AI Palmistry</p>
              </div>
              <button
                type="button"
                onClick={resetApp}
                className="px-5 py-2 bg-white/5 hover:bg-white/10 rounded-full text-xs text-indigo-200 border border-white/10 transition-colors"
              >
                やり直す
              </button>
            </div>

            <div className="result-content mb-10 overflow-hidden text-left" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(analysisMarkdown) }} />

            <div className="pt-8 border-t border-white/10">
              <h3 className="text-xl font-bold text-indigo-200 text-center mb-6">{`${displayName}さんの守護精霊 ✨`}</h3>
              <div className="glass-card bg-slate-900/50 min-h-[250px] overflow-hidden flex flex-col items-center justify-center p-6 text-center">
                {spiritState.status === "idle" && (
                  <div className="flex flex-col items-center gap-4" id="spirit-idle">
                    <p className="text-sm text-slate-400">あなたの性質を象徴する精霊を召喚します</p>
                    <button
                      type="button"
                      onClick={handleSummonSpirit}
                      className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold rounded-xl shadow-lg"
                    >
                      精霊を召喚する
                    </button>
                  </div>
                )}
                {spiritState.status === "loading" && (
                  <div className="flex flex-col items-center gap-4">
                    <div className="loader" />
                    <p className="text-sm animate-pulse">精霊を具現化中...</p>
                  </div>
                )}
                {spiritState.status === "done" && (
                  <>
                    <img src={spiritState.img} alt="Spirit" className="w-full h-auto rounded-xl shadow-2xl max-w-full" />
                    <p className="mt-4 text-sm italic text-slate-300">{spiritState.caption}</p>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="glass-card p-4 md:p-8 shadow-2xl w-full overflow-hidden">
            <h3 className="text-xl font-bold text-white mb-4">深層対話 ✨</h3>
            <div className="space-y-4 mb-6 max-h-80 overflow-y-auto p-4 bg-slate-900/30 rounded-xl text-sm flex flex-col w-full">
              {chatLogs.map((log, idx) => {
                if (log.sender === "system") {
                  return (
                    <p key={idx} className="text-slate-500 text-center italic text-xs">
                      {log.text}
                    </p>
                  );
                }
                const isUser = log.sender === "user";
                return (
                  <div
                    key={idx}
                    className={`chat-bubble p-3 rounded-lg text-xs mb-2 ${
                      isUser ? "self-end text-right bg-indigo-600/30" : "self-start text-left bg-slate-700/50"
                    }`}
                  >
                    {log.text}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 w-full">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleChat();
                }}
                placeholder="質問を入力..."
                className="flex-1 min-w-0 bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={handleChat}
                className="px-4 md:px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold whitespace-nowrap"
              >
                送信
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="w-full py-4 bg-slate-800 hover:bg-slate-700 rounded-xl text-white font-bold border border-white/5 transition-colors"
          >
            鑑定結果をコピー
          </button>
        </section>
      )}

      <footer className="w-full max-w-3xl px-4 mt-8 pb-12 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="glass-card p-6 text-left border-white/5 overflow-hidden">
            <h3 className="text-indigo-300 font-bold text-sm mb-3 tracking-wide">実践的なアドバイス</h3>
            <div className="space-y-3 text-[11px] text-slate-400 leading-relaxed text-left">
              <p>
                <strong>指先を写さない:</strong> 鑑定に必要なのは「手のひら」中央の線です。指紋部分は写さないよう配慮してください。
              </p>
              <p>
                <strong>背景に配慮する:</strong> 自身の顔、住所、鏡など、個人情報が写り込まない場所で撮影してください。
              </p>
              <p>
                <strong>匿名性の保持:</strong> 名前はニックネームで構いません。画像と実名の紐付けを避けることができます。
              </p>
            </div>
          </div>

          <div className="glass-card p-6 text-left border-white/5 overflow-hidden">
            <h3 className="text-rose-300/80 font-bold text-sm mb-3 tracking-wide">ご利用上の注意・免責事項</h3>
            <div className="space-y-3 text-[11px] text-slate-400 leading-relaxed text-left">
              <p>
                <strong>サンプルアプリとしての提供:</strong> 本アプリは技術デモンストレーション用のサンプルです。操作方法や技術的な仕様、その他に関するお問い合わせへの個別対応は致しかねます。
              </p>
              <p>
                <strong>サービスの内容変更・廃止:</strong> 本アプリの機能や提供内容は、事前の予告なく変更、または提供を終了する場合がございます。あらかじめご了承ください。
              </p>
              <p>
                <strong>責任の制限:</strong> 本アプリのご利用、および鑑定結果の内容によって生じた損害やトラブル等について、当方は一切の責任を負いかねます。自己の責任においてご利用ください。
              </p>
            </div>
          </div>
        </div>

        <div className="text-center text-slate-500 text-[10px] mt-6">
          <p>© 2025 AI お手を拝借 Pro. Powered by Gemini 2.5 Flash</p>
        </div>
      </footer>

      {toast && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-indigo-600 text-white px-6 py-3 rounded-full shadow-2xl z-[300] text-sm font-bold whitespace-nowrap">
          {toast}
        </div>
      )}

      {quotaModal && (
        <div className="modal-overlay z-[500]">
          <div className="glass-card max-w-md w-full p-6 md:p-8 space-y-4 shadow-2xl">
            <h3 className="text-xl font-bold text-white text-center mb-2">ご利用制限について</h3>
            <p className="text-sm text-slate-300 text-center leading-relaxed">
              無料枠を使い切ったため、本日はご利用いただけません。明日以降か、課金設定後にお試しください。
            </p>
            <button
              type="button"
              onClick={() => setQuotaModal(false)}
              className="w-full py-3 rounded-xl bg-indigo-600 text-white font-bold shadow-lg hover:opacity-90"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
