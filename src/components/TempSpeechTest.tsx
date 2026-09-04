import React, { useState, useRef, useCallback } from 'react';
import { X, Mic, MicOff, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

/**
 * 临时语音转文字测试窗口
 * 用于隔离测试 SpeechRecognition API 是否正常工作
 * 测试完成后请删除此组件及相关引用
 */
const TempSpeechTest: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [status, setStatus] = useState<'idle' | 'listening' | 'detected' | 'converting' | 'done' | 'error'>('idle');
  const [result, setResult] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const recognitionRef = useRef<any>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const cleanup = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }
  }, []);

  const handleStart = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorMsg('当前浏览器不支持 SpeechRecognition API');
      setStatus('error');
      addLog('[错误] SpeechRecognition 不可用');
      return;
    }

    cleanup();
    setResult('');
    setErrorMsg('');
    setStatus('idle');
    addLog('开始初始化...');

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = 'zh-CN';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      setStatus('listening');
      addLog('onstart — 识别已启动');
    };

    recognition.onaudiostart = () => {
      setStatus('detected');
      addLog('onaudiostart — 检测到音频');
    };

    recognition.onaudioend = () => {
      setStatus('converting');
      addLog('onaudioend — 音频结束，正在转换...');
    };

    recognition.onspeechstart = () => {
      addLog('onspeechstart — 检测到语音');
    };

    recognition.onspeechend = () => {
      addLog('onspeechend — 语音结束');
    };

    recognition.onsoundstart = () => {
      addLog('onsoundstart — 检测到声音');
    };

    recognition.onsoundend = () => {
      addLog('onsoundend — 声音结束');
    };

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setResult(transcript);
      addLog(`onresult — 识别结果: "${transcript}"`);
    };

    recognition.onerror = (event: any) => {
      const errMap: Record<string, string> = {
        'no-speech': '未检测到语音',
        'aborted': '识别被中止',
        'audio-capture': '无法获取麦克风',
        'network': '网络错误',
        'not-allowed': '麦克风权限被拒绝',
        'service-not-allowed': '语音服务不可用',
        'bad-grammar': '语法错误',
        'language-not-supported': '不支持该语言',
      };
      const msg = errMap[event.error] || event.error;
      setErrorMsg(`错误: ${msg} (${event.error})`);
      setStatus('error');
      addLog(`[错误] onerror — ${msg} (${event.error})`);
      cleanup();
    };

    recognition.onend = () => {
      addLog('onend — 识别结束');
      if (status !== 'error') {
        setStatus('done');
      }
      cleanup();
    };

    try {
      recognition.start();
      addLog('recognition.start() 已调用');

      // 15 秒超时
      timeoutRef.current = setTimeout(() => {
        addLog('15秒超时，自动停止');
        cleanup();
        if (status === 'listening' || status === 'detected') {
          setErrorMsg('超时: 15秒内未检测到有效语音');
          setStatus('error');
        }
      }, 15000);
    } catch (e: any) {
      setErrorMsg(`启动失败: ${e.message}`);
      setStatus('error');
      addLog(`[错误] 启动异常: ${e.message}`);
    }
  };

  const handleStop = () => {
    addLog('手动停止');
    cleanup();
    setStatus('idle');
  };

  const statusLabel: Record<string, string> = {
    idle: '就绪',
    listening: '正在聆听...',
    detected: '检测到声音',
    converting: '正在转换...',
    done: '识别完成',
    error: '发生错误',
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#1e1b2e',
          borderRadius: 16,
          padding: 28,
          width: 520,
          maxHeight: '80vh',
          overflow: 'auto',
          color: '#e2e8f0',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          border: '1px solid #334155',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            语音转文字测试
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 6 }}>当前状态</div>
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              background:
                status === 'error' ? 'rgba(239,68,68,0.15)' :
                status === 'done' ? 'rgba(34,197,94,0.15)' :
                status === 'idle' ? 'rgba(100,116,139,0.1)' :
                'rgba(99,102,241,0.15)',
              border: '1px solid ' + (
                status === 'error' ? 'rgba(239,68,68,0.3)' :
                status === 'done' ? 'rgba(34,197,94,0.3)' :
                status === 'idle' ? 'rgba(100,116,139,0.2)' :
                'rgba(99,102,241,0.3)'
              ),
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 14,
            }}
          >
            {status === 'error' && <AlertTriangle className="w-4 h-4" style={{ color: '#ef4444' }} />}
            {status === 'done' && <CheckCircle2 className="w-4 h-4" style={{ color: '#22c55e' }} />}
            {status === 'listening' && <Clock className="w-4 h-4" style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />}
            <span style={{ fontWeight: 500 }}>{statusLabel[status]}</span>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <button
            onClick={handleStart}
            disabled={status === 'listening' || status === 'detected' || status === 'converting'}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '10px 16px',
              borderRadius: 10,
              background: (status === 'listening' || status === 'detected' || status === 'converting')
                ? '#334155'
                : '#6366f1',
              color: '#fff',
              border: 'none',
              cursor: (status === 'listening' || status === 'detected' || status === 'converting') ? 'not-allowed' : 'pointer',
              fontSize: 14,
              fontWeight: 500,
              opacity: (status === 'listening' || status === 'detected' || status === 'converting') ? 0.5 : 1,
            }}
          >
            <Mic className="w-4 h-4" /> 开始识别
          </button>
          <button
            onClick={handleStop}
            disabled={status === 'idle' || status === 'done' || status === 'error'}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '10px 16px',
              borderRadius: 10,
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              cursor: (status === 'idle' || status === 'done' || status === 'error') ? 'not-allowed' : 'pointer',
              fontSize: 14,
              fontWeight: 500,
              opacity: (status === 'idle' || status === 'done' || status === 'error') ? 0.5 : 1,
            }}
          >
            <MicOff className="w-4 h-4" /> 停止
          </button>
        </div>

        {/* Error */}
        {errorMsg && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#fca5a5',
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* Result */}
        {result && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 6 }}>识别结果</div>
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                background: 'rgba(34,197,94,0.1)',
                border: '1px solid rgba(34,197,94,0.3)',
                color: '#bbf7d0',
                fontSize: 15,
                fontWeight: 500,
                lineHeight: 1.6,
              }}
            >
              "{result}"
            </div>
          </div>
        )}

        {/* Event Logs */}
        <div>
          <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 6 }}>事件日志</div>
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid #1e293b',
              maxHeight: 200,
              overflow: 'auto',
              fontSize: 12,
              fontFamily: 'monospace',
              lineHeight: 1.8,
            }}
          >
            {logs.length === 0 ? (
              <span style={{ color: '#64748b' }}>点击「开始识别」查看事件日志...</span>
            ) : (
              logs.map((log, i) => (
                <div key={i} style={{ color: log.startsWith('[错误]') ? '#fca5a5' : '#94a3b8' }}>
                  {log}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Browser Info */}
        <div style={{ marginTop: 14, fontSize: 11, color: '#475569', textAlign: 'center' }}>
          浏览器: {navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.includes('Edge') ? 'Edge' : '其他'}
          {' | '}
          语言: {navigator.language}
          {' | '}
          SpeechRecognition: {(window as any).SpeechRecognition || (window as any).webkitSpeechRecognition ? '可用' : '不可用'}
        </div>
      </div>
    </div>
  );
};

export default TempSpeechTest;