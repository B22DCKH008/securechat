import { useEffect, useState } from 'react';
import type { AnalysisStatus, MessageAnalysis } from '../ai/contract';
import { LocalRiskAnalyzer } from '../ai/runtime/analyzer';
import {
  analyzeConversationRisk,
  type ConversationRiskSummary,
} from '../ai/runtime/conversationRisk';
import { scanImageOnDevice } from '../ai/runtime/imageScanner';
import { ChatHeader } from '../components/chat/ChatHeader';
import { Composer } from '../components/chat/Composer';
import { InfoPanel } from '../components/chat/InfoPanel';
import { MessageList } from '../components/chat/MessageList';
import { Sidebar } from '../components/chat/Sidebar';
import { ReportScamModal } from '../components/warnings/ReportScamModal';
import { RiskWarning } from '../components/warnings/RiskWarning';
import type {
  ProfileUpdatePayload,
  RegisterPayload,
  ScamReport,
  UserAccount,
} from '../features/auth/types';
import type { ChatMessage, Conversation } from '../features/conversations/types';
import { AuthPage } from '../pages/AuthPage';
import { BenchPage } from '../pages/BenchPage';
import { PhoneVerifyPage } from '../pages/PhoneVerifyPage';
import { ProfilePage } from '../pages/ProfilePage';
import { TestLabPage } from '../pages/TestLabPage';
import {
  ensureSeedUsers,
  hashPassword,
  isValidEmail,
  isValidVnPhone,
  loadAliasesForUser,
  loadConversationsForUser,
  loadReports,
  loadSessionUserId,
  normalizeEmail,
  normalizePhone,
  saveAliasForUser,
  saveConversationsForUser,
  saveReports,
  saveSessionUserId,
  saveUsers,
} from '../storage/localStore';

type Route = 'chat' | 'test' | 'bench' | 'profile';

function readRoute(): Route {
  if (window.location.pathname.startsWith('/bench')) return 'bench';
  if (window.location.pathname.startsWith('/test')) return 'test';
  if (window.location.pathname.startsWith('/profile')) return 'profile';
  return 'chat';
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowTime(): string {
  return new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [analyzer] = useState(() => new LocalRiskAnalyzer());
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiStatus, setAiStatus] = useState<AnalysisStatus>('unavailable');
  const [modelVersion, setModelVersion] = useState<string | undefined>(undefined);
  const [coldStartMs, setColdStartMs] = useState<number | null>(null);

  const [users, setUsers] = useState<UserAccount[]>([]);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [reports, setReports] = useState<ScamReport[]>(() => loadReports());
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [showInfoPanel, setShowInfoPanel] = useState(true);
  const [showReportModal, setShowReportModal] = useState(false);
  const [activeConvRisk, setActiveConvRisk] = useState<ConversationRiskSummary | null>(null);

  const [draft, setDraft] = useState('');
  const [pendingWarning, setPendingWarning] = useState<{
    text: string;
    analysis: MessageAnalysis;
    matchedRules: string[];
    imageUrl?: string;
    imageName?: string;
    qrPayloads?: string[];
  } | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    void ensureSeedUsers().then((seeded) => {
      setUsers(seeded);
      const savedId = loadSessionUserId();
      if (savedId) {
        const found = seeded.find((u) => u.id === savedId);
        if (found) activateUserSession(found);
      }
    });
  }, []);

  useEffect(() => {
    let active = true;
    const t0 = performance.now();
    analyzer
      .init()
      .then(async () => {
        const probe = await analyzer.analyzeMessage('xin chao');
        if (!active) return;
        setColdStartMs(performance.now() - t0);
        setAiStatus(probe.status);
        setModelVersion(probe.modelVersion);
      })
      .catch(() => {
        if (!active) return;
        setAiStatus('error');
      });
    return () => {
      active = false;
    };
  }, [analyzer]);

  useEffect(() => {
    if (!currentUser || !currentUser.phoneVerified || !aiEnabled || aiStatus !== 'ok' || !analyzer.isReady()) {
      return;
    }
    let cancelled = false;

    async function rescanUnanalyzed() {
      let changed = false;
      const updated: Conversation[] = [];
      for (const conv of conversations) {
        const nextMsgs: ChatMessage[] = [];
        for (const m of conv.messages) {
          if (m.analysis.status === 'unavailable' && m.text.trim()) {
            const analysis = await analyzer.analyzeMessage(m.text);
            const matchedRules = analyzer.getMatchedRules(m.text);
            nextMsgs.push({ ...m, analysis, matchedRules });
            changed = true;
          } else {
            nextMsgs.push(m);
          }
        }
        updated.push({ ...conv, messages: nextMsgs });
      }
      if (!cancelled && changed && currentUser) {
        setConversations(updated);
        saveConversationsForUser(currentUser.id, updated);
      }
    }

    void rescanUnanalyzed();
    return () => {
      cancelled = true;
    };
  }, [currentUser, aiEnabled, aiStatus, analyzer, conversations]);

  const activeConversation =
    conversations.find((c) => c.id === activeId) ?? conversations[0];

  const peerReports = activeConversation?.peerUserId
    ? reports.filter((r) => r.targetUserId === activeConversation.peerUserId)
    : [];

  useEffect(() => {
    if (!currentUser?.phoneVerified || !activeConversation) {
      setActiveConvRisk(null);
      return;
    }
    let cancelled = false;
    void analyzeConversationRisk({
      messages: activeConversation.messages,
      isStranger: activeConversation.isStranger,
      peerReportsCount: peerReports.length,
      analyzer,
    }).then((summary) => {
      if (!cancelled) setActiveConvRisk(summary);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUser, activeConversation, peerReports.length, aiEnabled, aiStatus, analyzer]);

  function activateUserSession(user: UserAccount) {
    setCurrentUser(user);
    saveSessionUserId(user.id);
    const userConvs = loadConversationsForUser(user);
    setConversations(userConvs);
    setActiveId(userConvs[0]?.id ?? '');
    setAliases(loadAliasesForUser(user.id));
    setReports(loadReports());
    setSelectedMessageId(null);
    setPendingWarning(null);
  }

  async function handleLogin(identifier: string, password: string): Promise<string | null> {
    const cleanEmail = normalizeEmail(identifier);
    const cleanPhone = normalizePhone(identifier);
    const cleanUser = identifier.trim().replace(/^@/, '').toLowerCase();

    const found = users.find(
      (u) =>
        u.email.toLowerCase() === cleanEmail ||
        (u.phone && u.phone === cleanPhone) ||
        u.username.toLowerCase() === cleanUser,
    );
    if (!found) return 'Không tìm thấy tài khoản khớp với email, SĐT hoặc username này.';
    const pwHash = await hashPassword(password);
    if (found.passwordHash !== pwHash) return 'Mật khẩu không chính xác.';
    activateUserSession(found);
    return null;
  }

  function handleValidateRegister(payload: RegisterPayload): string | null {
    const cleanEmail = normalizeEmail(payload.email);
    const cleanUser = payload.username.replace(/^@/, '').toLowerCase();

    if (payload.displayName.length < 2) {
      return 'Họ và tên hiển thị phải có ít nhất 2 ký tự.';
    }
    if (!isValidEmail(cleanEmail)) {
      return 'Địa chỉ email không đúng định dạng.';
    }
    if (!/^[a-z0-9._-]{3,24}$/.test(cleanUser)) {
      return 'Tên định danh (@username) gồm 3–24 ký tự thường, số, dấu chấm hoặc gạch dưới.';
    }
    if (payload.password.length < 6) {
      return 'Mật khẩu phải có ít nhất 6 ký tự.';
    }
    if (users.some((u) => u.email.toLowerCase() === cleanEmail)) {
      return 'Địa chỉ email này đã được đăng ký cho một tài khoản khác (mỗi email là duy nhất).';
    }
    if (users.some((u) => u.username.toLowerCase() === cleanUser)) {
      return 'Tên định danh (@username) này đã có người sử dụng.';
    }
    return null;
  }

  async function handleCompleteRegister(payload: RegisterPayload): Promise<string | null> {
    const err = handleValidateRegister(payload);
    if (err) return err;
    const cleanEmail = normalizeEmail(payload.email);
    const cleanUser = payload.username.replace(/^@/, '').toLowerCase();
    const palette = ['#0068ff', '#059669', '#7c3aed', '#0284c7', '#d97706'];
    const newUser: UserAccount = {
      id: `u-${Date.now()}`,
      username: cleanUser,
      displayName: payload.displayName,
      email: cleanEmail,
      phone: '',
      emailVerified: true,
      phoneVerified: false,
      passwordHash: await hashPassword(payload.password),
      avatarText: initialsFromName(payload.displayName),
      avatarColor: palette[users.length % palette.length],
      bio: 'Thành viên SecureChat đã xác thực OTP',
      isOnline: true,
      createdAt: new Date().toISOString(),
    };
    const nextUsers = [...users, newUser];
    setUsers(nextUsers);
    saveUsers(nextUsers);
    activateUserSession(newUser);
    return null;
  }

  function handleValidatePhone(rawPhone: string): string | null {
    const cleanPhone = normalizePhone(rawPhone);
    if (!isValidVnPhone(cleanPhone)) {
      return 'Số điện thoại không hợp lệ (cần 10 chữ số di động Việt Nam, ví dụ 0912345678).';
    }
    if (users.some((u) => u.id !== currentUser?.id && u.phone === cleanPhone)) {
      return 'Số điện thoại này đã thuộc về tài khoản khác. Mỗi SĐT chỉ được gắn với 1 tài khoản duy nhất.';
    }
    return null;
  }

  function handleBindVerifiedPhone(rawPhone: string) {
    if (!currentUser) return;
    const cleanPhone = normalizePhone(rawPhone);
    const updated: UserAccount = {
      ...currentUser,
      phone: cleanPhone,
      phoneVerified: true,
    };
    const nextUsers = users.map((u) => (u.id === currentUser.id ? updated : u));
    setUsers(nextUsers);
    saveUsers(nextUsers);
    setCurrentUser(updated);
  }

  function handleUpdateProfile(patch: ProfileUpdatePayload) {
    if (!currentUser) return;
    const updatedUser: UserAccount = {
      ...currentUser,
      displayName: patch.displayName,
      bio: patch.bio,
      avatarUrl: patch.avatarUrl,
      avatarText: initialsFromName(patch.displayName),
      email: currentUser.email,
      phone: currentUser.phone,
      username: currentUser.username,
    };
    const nextUsers = users.map((u) => (u.id === currentUser.id ? updatedUser : u));
    setUsers(nextUsers);
    saveUsers(nextUsers);
    setCurrentUser(updatedUser);
  }

  function handleLogout() {
    saveSessionUserId(null);
    setCurrentUser(null);
    setPendingWarning(null);
    setShowReportModal(false);
    navigate('chat');
  }

  function navigate(next: Route) {
    const target =
      next === 'bench'
        ? '/bench'
        : next === 'test'
          ? '/test'
          : next === 'profile'
            ? '/profile'
            : '/';
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
    setRoute(next);
  }

  function handleToggleAI(next: boolean) {
    setAiEnabled(next);
    analyzer.setEnabled(next);
    setPendingWarning(null);
  }

  function persistConversations(next: Conversation[]) {
    setConversations(next);
    if (currentUser) saveConversationsForUser(currentUser.id, next);
  }

  function handleSelectConversation(convId: string, jumpMessageId?: string) {
    setActiveId(convId);
    setSelectedMessageId(jumpMessageId ?? null);
    setPendingWarning(null);
    if (route !== 'chat') navigate('chat');
  }

  function handleStartDirectChat(peer: UserAccount) {
    const existing = conversations.find((c) => c.peerUserId === peer.id);
    if (existing) {
      handleSelectConversation(existing.id);
      return;
    }
    const newConv: Conversation = {
      id: `conv-dm-${peer.id}`,
      type: 'direct',
      peerUserId: peer.id,
      name: peer.displayName,
      avatarText: peer.avatarText,
      avatarColor: peer.avatarColor,
      subtitle: `${peer.phone || peer.email} · ${peer.isOnline ? 'Đang hoạt động' : 'Ngoại tuyến'}`,
      isOnline: peer.isOnline,
      isStranger: true,
      messages: [],
    };
    persistConversations([newConv, ...conversations]);
    setActiveId(newConv.id);
    setSelectedMessageId(null);
  }

  function handleCreateGroup() {
    const name = window.prompt('Nhập tên nhóm mới:');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const newConv: Conversation = {
      id: `conv-grp-${Date.now()}`,
      type: 'group',
      name: trimmed,
      avatarText: initialsFromName(trimmed),
      avatarColor: '#0284c7',
      subtitle: 'Nhóm mới · Đang hoạt động',
      isOnline: true,
      messages: [],
    };
    persistConversations([newConv, ...conversations]);
    setActiveId(newConv.id);
    setSelectedMessageId(null);
  }

  if (!currentUser) {
    return (
      <AuthPage
        onLogin={handleLogin}
        onValidateRegister={handleValidateRegister}
        onCompleteRegister={handleCompleteRegister}
        onQuickLogin={(uid) => {
          const found = users.find((u) => u.id === uid);
          if (found) activateUserSession(found);
        }}
        demoUsers={users}
      />
    );
  }

  if (!currentUser.phoneVerified || !currentUser.phone) {
    return (
      <PhoneVerifyPage
        user={currentUser}
        onValidatePhone={handleValidatePhone}
        onBindVerifiedPhone={handleBindVerifiedPhone}
        onLogout={handleLogout}
      />
    );
  }

  const activePeer = activeConversation?.peerUserId
    ? users.find((u) => u.id === activeConversation.peerUserId)
    : undefined;

  const activeDisplayName = activeConversation
    ? aliases[activeConversation.id] || activePeer?.displayName || activeConversation.name
    : '';

  const alreadyReportedByMe = peerReports.some((r) => r.reporterUserId === currentUser.id);
  const myReportsCount = reports.filter((r) => r.reporterUserId === currentUser.id).length;

  const selectedMessage = activeConversation
    ? activeConversation.messages.find((m) => m.id === selectedMessageId) ??
      activeConversation.messages[activeConversation.messages.length - 1] ??
      null
    : null;

  function appendMessage(
    direction: 'outgoing' | 'incoming',
    text: string,
    analysis: MessageAnalysis,
    matchedRules: string[],
    extra?: { imageUrl?: string; imageName?: string; qrPayloads?: string[] },
  ) {
    if (!activeConversation || !currentUser) return;
    const newMsg: ChatMessage = {
      id: makeId(),
      senderId: direction === 'outgoing' ? currentUser.id : activeConversation.peerUserId ?? 'peer',
      senderName: direction === 'outgoing' ? currentUser.displayName : activeDisplayName,
      direction,
      text,
      timestamp: nowTime(),
      deliveryStatus: direction === 'outgoing' ? 'delivered' : undefined,
      analysis,
      matchedRules,
      ...extra,
    };
    const next = conversations.map((c) =>
      c.id === activeConversation.id ? { ...c, messages: [...c.messages, newMsg] } : c,
    );
    persistConversations(next);
    setSelectedMessageId(newMsg.id);
  }

  async function handleSendOutgoing() {
    const text = draft.trim();
    if (!text) return;
    const analysis = await analyzer.analyzeMessage(text);
    const matchedRules = analyzer.getMatchedRules(text);
    if (analysis.status === 'ok' && (analysis.label === 'scam' || analysis.label === 'spam')) {
      setPendingWarning({ text, analysis, matchedRules });
      return;
    }
    appendMessage('outgoing', text, analysis, matchedRules);
    setDraft('');
  }

  async function handleSendImage(file: File) {
    const imageUrl = URL.createObjectURL(file);
    const scanned = await scanImageOnDevice(file, analyzer);
    const caption = draft.trim();
    const scanText = [caption, ...scanned.qrPayloads].filter(Boolean).join(' ');
    const analysis = scanText ? await analyzer.analyzeMessage(scanText) : scanned.analysis;
    const matchedRules = scanText ? analyzer.getMatchedRules(scanText) : scanned.matchedRules;

    if (analysis.status === 'ok' && (analysis.label === 'scam' || analysis.label === 'spam')) {
      setPendingWarning({
        text: caption || `[Ảnh: ${file.name}]`,
        analysis,
        matchedRules,
        imageUrl,
        imageName: file.name,
        qrPayloads: scanned.qrPayloads,
      });
      return;
    }

    appendMessage('outgoing', caption, analysis, matchedRules, {
      imageUrl,
      imageName: file.name,
      qrPayloads: scanned.qrPayloads,
    });
    setDraft('');
  }

  function handleConfirmSend() {
    if (!pendingWarning) return;
    appendMessage(
      'outgoing',
      pendingWarning.text,
      pendingWarning.analysis,
      pendingWarning.matchedRules,
      {
        imageUrl: pendingWarning.imageUrl,
        imageName: pendingWarning.imageName,
        qrPayloads: pendingWarning.qrPayloads,
      },
    );
    setPendingWarning(null);
    setDraft('');
  }

  async function handleSimulateIncoming() {
    const text = draft.trim();
    if (!text) return;
    const analysis = await analyzer.analyzeMessage(text);
    const matchedRules = analyzer.getMatchedRules(text);
    appendMessage('incoming', text, analysis, matchedRules);
    setDraft('');
    setPendingWarning(null);
  }

  function handleSubmitScamReport(reason: string, note: string) {
    if (!activeConversation?.peerUserId || !currentUser) return;
    const newReport: ScamReport = {
      id: makeId(),
      targetUserId: activeConversation.peerUserId,
      reporterUserId: currentUser.id,
      reporterName: currentUser.displayName,
      reason,
      note,
      createdAt: new Date().toISOString(),
    };
    const next = [...reports, newReport];
    setReports(next);
    saveReports(next);
    setShowReportModal(false);
  }

  const railDotClass = !aiEnabled
    ? 'warn'
    : aiStatus === 'ok'
      ? 'ok'
      : aiStatus === 'error'
        ? 'err'
        : 'warn';

  return (
    <div className="messenger-shell">
      <nav className="nav-rail" aria-label="Điều hướng chính">
        <div className="rail-logo" title={`SecureChat — ${currentUser.displayName}`}>SC</div>

        <button
          type="button"
          className={`rail-btn ${route === 'chat' ? 'active' : ''}`}
          title="Nhắn tin"
          onClick={() => navigate('chat')}
        >
          💬
        </button>

        <button
          type="button"
          className={`rail-btn ${route === 'test' ? 'active' : ''}`}
          title="Phòng thử nghiệm AI (/test)"
          onClick={() => navigate('test')}
        >
          🧪
        </button>

        <button
          type="button"
          className={`rail-btn ${route === 'bench' ? 'active' : ''}`}
          title="Đo hiệu năng (/bench)"
          onClick={() => navigate('bench')}
        >
          ⚡
        </button>

        <div className="rail-spacer" />

        <button
          type="button"
          className="rail-btn"
          title={aiEnabled ? 'AI bảo vệ đang bật (bấm để tắt)' : 'AI bảo vệ đang tắt (bấm để bật)'}
          onClick={() => handleToggleAI(!aiEnabled)}
        >
          🛡
          <span className={`rail-dot ${railDotClass}`} />
        </button>

        <button
          type="button"
          className={`rail-avatar-btn ${route === 'profile' ? 'active' : ''}`}
          title={`Hồ sơ cá nhân: ${currentUser.displayName} (${currentUser.phone})`}
          onClick={() => navigate('profile')}
        >
          <div className="avatar sm" style={{ background: currentUser.avatarColor }}>
            {currentUser.avatarUrl ? (
              <img src={currentUser.avatarUrl} alt={currentUser.displayName} />
            ) : (
              currentUser.avatarText
            )}
          </div>
        </button>

        <button
          type="button"
          className="rail-btn"
          title="Đăng xuất / Đổi tài khoản"
          onClick={handleLogout}
        >
          ↪
        </button>
      </nav>

      {route === 'bench' ? (
        <div className="page-scroll">
          <BenchPage />
        </div>
      ) : route === 'test' ? (
        <TestLabPage analyzer={analyzer} aiEnabled={aiEnabled} />
      ) : route === 'profile' ? (
        <ProfilePage
          user={currentUser}
          myReportsCount={myReportsCount}
          aiEnabled={aiEnabled}
          modelVersion={modelVersion}
          onSaveProfile={handleUpdateProfile}
          onLogout={handleLogout}
        />
      ) : (
        <>
          <Sidebar
            currentUser={currentUser}
            users={users}
            conversations={conversations}
            aliases={aliases}
            reports={reports}
            activeId={activeConversation?.id ?? ''}
            onSelectConversation={handleSelectConversation}
            onStartDirectChat={handleStartDirectChat}
            onCreateGroup={handleCreateGroup}
          />

          {activeConversation && (
            <>
              <main className="chat-main">
                <ChatHeader
                  conversation={activeConversation}
                  displayName={activeDisplayName}
                  peerReports={peerReports}
                  conversationRisk={activeConvRisk}
                  aiStatus={aiStatus}
                  aiEnabled={aiEnabled}
                  modelVersion={modelVersion}
                  coldStartMs={coldStartMs}
                  showInfoPanel={showInfoPanel}
                  onToggleInfoPanel={() => setShowInfoPanel((v) => !v)}
                  onOpenReportModal={() => setShowReportModal(true)}
                />

                <MessageList
                  conversation={activeConversation}
                  selectedMessageId={selectedMessage?.id ?? null}
                  onSelectMessage={(msg) => setSelectedMessageId(msg.id)}
                />

                {pendingWarning && (
                  <RiskWarning
                    analysis={pendingWarning.analysis}
                    pendingText={pendingWarning.text}
                    onConfirmSend={handleConfirmSend}
                    onCancel={() => setPendingWarning(null)}
                  />
                )}

                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSendOutgoing={() => void handleSendOutgoing()}
                  onSimulateIncoming={() => void handleSimulateIncoming()}
                  onSendImage={(file) => void handleSendImage(file)}
                />
              </main>

              {showInfoPanel && (
                <InfoPanel
                  conversation={activeConversation}
                  currentAlias={aliases[activeConversation.id] ?? ''}
                  onSaveAlias={(nick) => {
                    const next = saveAliasForUser(currentUser.id, activeConversation.id, nick);
                    setAliases(next);
                  }}
                  peerReports={peerReports}
                  alreadyReportedByMe={alreadyReportedByMe}
                  onOpenReportModal={() => setShowReportModal(true)}
                  conversationRisk={activeConvRisk}
                  aiEnabled={aiEnabled}
                  onToggleAI={handleToggleAI}
                  modelVersion={modelVersion}
                  selectedMessage={selectedMessage}
                />
              )}
            </>
          )}
        </>
      )}

      {showReportModal && activeConversation && (
        <ReportScamModal
          targetName={activeDisplayName}
          onSubmit={handleSubmitScamReport}
          onClose={() => setShowReportModal(false)}
        />
      )}
    </div>
  );
}