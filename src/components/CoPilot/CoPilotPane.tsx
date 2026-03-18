// ─── CoPilotPane ────────────────────────────────────────────────────────────
// Chat interface with message history, quick-action buttons,
// collapsible action stream, and advisor config.

import { useRef, useEffect, useState, useCallback } from 'react';
import { useNatureRiskStore } from '@/store';
import { ChatMessage } from '@/components/CoPilot/ChatMessage';
import { ActionStream } from '@/components/CoPilot/ActionStream';
import { AdvisorConfig } from '@/components/Config/AdvisorConfig';
import { PdfExport } from '@/components/Export/PdfExport';
import { v4 as uuidv4 } from 'uuid';
import type { AnalysisMode, UserIntent } from '@/types';

const QUICK_ACTIONS = [
  'What upstream restoration would protect this asset?',
  'What assets benefit from this intervention?',
] as const;

export function CoPilotPane() {
  const messages = useNatureRiskStore((s) => s.messages);
  const currentStep = useNatureRiskStore((s) => s.currentStep);
  const mode = useNatureRiskStore((s) => s.mode);
  const userIntent = useNatureRiskStore((s) => s.userIntent);
  const assetPin = useNatureRiskStore((s) => s.assetPin);
  const appendMessage = useNatureRiskStore((s) => s.appendMessage);
  const setUserIntent = useNatureRiskStore((s) => s.setUserIntent);
  const runAnalysis = useNatureRiskStore((s) => s.runAnalysis);

  const [inputText, setInputText] = useState('');
  const [configExpanded, setConfigExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isAnalysing =
    currentStep !== 'idle' &&
    currentStep !== 'complete' &&
    currentStep !== 'error';

  // Scroll to latest message
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages]);

  // Send message: append user message, then trigger analysis
  const handleSend = useCallback(
    (text?: string) => {
      const content = (text ?? inputText).trim();
      if (!content || isAnalysing) return;

      appendMessage({
        id: uuidv4(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });

      setInputText('');
      inputRef.current?.focus();

      // Trigger analysis pipeline
      runAnalysis();
    },
    [inputText, isAnalysing, appendMessage, runAnalysis],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleQuickAction = useCallback(
    (text: string) => {
      if (isAnalysing) return;
      handleSend(text);
    },
    [isAnalysing, handleSend],
  );

  const analysisMode: AnalysisMode = mode ?? 'inland';
  const modeBadgeColors: Record<AnalysisMode, { bg: string; border: string; color: string }> = {
    inland: {
      bg: 'rgba(59,130,246,0.15)',
      border: 'rgba(59,130,246,0.35)',
      color: 'var(--blue)',
    },
    coastal: {
      bg: 'rgba(6,182,212,0.15)',
      border: 'rgba(6,182,212,0.35)',
      color: 'var(--teal)',
    },
    mixed: {
      bg: 'rgba(52,211,153,0.15)',
      border: 'rgba(52,211,153,0.35)',
      color: 'var(--green)',
    },
  };

  const badge = modeBadgeColors[analysisMode];

  return (
    <>
      {/* Header */}
      <header
        style={{
          padding: '14px 18px 12px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'rgba(10,22,40,0.6)',
          backdropFilter: 'blur(8px)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              aria-hidden="true"
              style={{
                width: 32,
                height: 32,
                background: 'linear-gradient(135deg, var(--green), var(--teal))',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              &#127807;
            </div>
            <div
              style={{
                fontSize: '1.05rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
                letterSpacing: '-0.3px',
              }}
            >
              Nature<span style={{ color: 'var(--green)' }}>Risk</span>
            </div>
          </div>

          <span
            role="status"
            aria-live="polite"
            aria-label={`Current analysis mode: ${analysisMode}`}
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              fontFamily: 'var(--mono)',
              padding: '3px 10px',
              borderRadius: 99,
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              background: badge.bg,
              border: `1px solid ${badge.border}`,
              color: badge.color,
              transition: 'all 0.3s ease',
            }}
          >
            {analysisMode}
          </span>
        </div>

        {/* User intent selector */}
        <div
          role="group"
          aria-label="User mode selection"
          style={{
            display: 'flex',
            gap: 6,
            background: 'rgba(10,22,40,0.6)',
            borderRadius: 'var(--radius-sm)',
            padding: 3,
          }}
        >
          {(['asset_manager', 'project_developer'] as UserIntent[]).map(
            (intent) => {
              const active = userIntent === intent;
              const isAsset = intent === 'asset_manager';
              const label = isAsset ? 'Asset Manager' : 'Project Developer';
              return (
                <button
                  key={intent}
                  role="radio"
                  aria-checked={active}
                  aria-label={
                    isAsset
                      ? 'Asset Manager mode -- analyse risk to existing assets'
                      : 'Project Developer mode -- analyse benefit of proposed interventions'
                  }
                  onClick={() => setUserIntent(intent)}
                  style={{
                    flex: 1,
                    padding: '7px 10px',
                    border: `1px solid ${
                      active
                        ? isAsset
                          ? 'var(--border-blue)'
                          : 'var(--border-glow)'
                        : 'transparent'
                    }`,
                    borderRadius: 6,
                    background: active ? 'var(--bg-elevated)' : 'transparent',
                    color: active
                      ? isAsset
                        ? 'var(--blue)'
                        : 'var(--green)'
                      : 'var(--text-secondary)',
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    fontFamily: 'var(--font)',
                  }}
                >
                  {label}
                </button>
              );
            },
          )}
        </div>
      </header>

      {/* Body: messages + action stream */}
      <div
        ref={bodyRef}
        tabIndex={-1}
        aria-label="Chat messages and analysis results"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <ActionStream />

        {messages.length === 0 && (
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              textAlign: 'center',
              padding: '24px 12px',
              border: '1px dashed var(--border-subtle)',
              borderRadius: 'var(--radius)',
              lineHeight: 1.6,
            }}
          >
            Draw a polygon or place a marker on the map, then type your query
            and click Analyse.
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {messages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {QUICK_ACTIONS.map((text) => (
              <button
                key={text}
                onClick={() => handleQuickAction(text)}
                disabled={isAnalysing}
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.78rem',
                  cursor: isAnalysing ? 'not-allowed' : 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font)',
                  transition: 'all 0.2s',
                  opacity: isAnalysing ? 0.5 : 1,
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}

        {/* Advisor config (collapsible) */}
        <div style={{ marginTop: 'auto' }}>
          <button
            onClick={() => setConfigExpanded((p) => !p)}
            aria-expanded={configExpanded}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.72rem',
              cursor: 'pointer',
              fontFamily: 'var(--font)',
              padding: '4px 0',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span
              style={{
                transform: configExpanded ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 0.2s',
                display: 'inline-block',
              }}
            >
              &#9660;
            </span>
            Advisor Settings
          </button>
          {configExpanded && <AdvisorConfig />}
        </div>
      </div>

      {/* Footer: Export + Chat input */}
      <footer
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border-subtle)',
          background: 'rgba(10,22,40,0.5)',
          flexShrink: 0,
        }}
      >
        <PdfExport />

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="e.g. What upstream restoration would best protect this asset from flood risk?"
            aria-label="Analysis query input"
            style={{
              flex: 1,
              padding: '9px 12px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: '0.83rem',
              fontFamily: 'var(--font)',
              outline: 'none',
              resize: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-glow)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-subtle)';
            }}
          />
          <button
            onClick={() => handleSend()}
            disabled={isAnalysing || !inputText.trim() || !assetPin}
            title={!assetPin ? 'Click the map to place an asset pin first' : undefined}
            aria-label="Run analysis"
            style={{
              padding: '9px 16px',
              background: 'linear-gradient(135deg, var(--green-dim), #059669)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: '#ffffff',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor:
                isAnalysing || !inputText.trim() || !assetPin ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font)',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 90,
              justifyContent: 'center',
              opacity: isAnalysing || !inputText.trim() || !assetPin ? 0.5 : 1,
              transition: 'all 0.2s ease',
            }}
          >
            {isAnalysing ? (
              <div
                aria-hidden="true"
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: '50%',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: 'white',
                  animation: 'spin 0.7s linear infinite',
                }}
              />
            ) : (
              'Analyse'
            )}
          </button>
        </div>
      </footer>
    </>
  );
}
