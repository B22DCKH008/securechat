import { useState } from 'react';
import type { ScamReport, UserAccount } from '../../features/auth/types';
import type { Conversation } from '../../features/conversations/types';

interface SidebarProps {
  currentUser: UserAccount;
  users: UserAccount[];
  conversations: Conversation[];
  aliases: Record<string, string>;
  reports: ScamReport[];
  activeId: string;
  onSelectConversation: (convId: string, jumpMessageId?: string) => void;
  onStartDirectChat: (peer: UserAccount) => void;
  onCreateGroup: () => void;
}

function getConversationRisk(c: Conversation): 'scam' | 'spam' | null {
  let hasSpam = false;
  for (const m of c.messages) {
    if (m.analysis.status === 'ok' && m.analysis.label === 'scam') return 'scam';
    if (m.analysis.status === 'ok' && m.analysis.label === 'spam') hasSpam = true;
  }
  return hasSpam ? 'spam' : null;
}

export function Sidebar({
  currentUser,
  users,
  conversations,
  aliases,
  reports,
  activeId,
  onSelectConversation,
  onStartDirectChat,
  onCreateGroup,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'risky'>('all');

  const q = query.trim().toLowerCase();
  const userMap = new Map(users.map((u) => [u.id, u]));

  const reportCountByUser = (userId?: string) =>
    userId ? reports.filter((r) => r.targetUserId === userId).length : 0;

  const getLabel = (c: Conversation) => {
    if (aliases[c.id]) return aliases[c.id];
    const peer = c.peerUserId ? userMap.get(c.peerUserId) : undefined;
    return peer ? peer.displayName : c.name;
  };

  const matchedConversations = conversations.filter((c) => {
    const risk = getConversationRisk(c);
    const repCount = reportCountByUser(c.peerUserId);
    if (!q && filter === 'risky' && !risk && repCount === 0) return false;
    if (!q) return true;
    const peer = c.peerUserId ? userMap.get(c.peerUserId) : undefined;
    return (
      getLabel(c).toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.subtitle.toLowerCase().includes(q) ||
      Boolean(peer?.phone.includes(q)) ||
      Boolean(peer?.email.toLowerCase().includes(q)) ||
      Boolean(peer?.username.toLowerCase().includes(q))
    );
  });

  const matchedMessages = q
    ? conversations.flatMap((c) =>
        c.messages
          .filter((m) => m.text.toLowerCase().includes(q))
          .map((m) => ({ conv: c, msg: m })),
      )
    : [];

  const existingPeerIds = new Set(conversations.map((c) => c.peerUserId).filter(Boolean));
  const matchedDirectoryUsers = q
    ? users.filter(
        (u) =>
          u.id !== currentUser.id &&
          !existingPeerIds.has(u.id) &&
          (u.displayName.toLowerCase().includes(q) ||
            u.username.toLowerCase().includes(q) ||
            u.phone.includes(q) ||
            u.email.toLowerCase().includes(q)),
      )
    : [];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Đoạn chat</h2>
        <button
          type="button"
          className="icon-btn"
          title="Tạo nhóm trò chuyện mới"
          onClick={onCreateGroup}
        >
          +
        </button>
      </div>

      <div className="sidebar-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm tên, SĐT, email, nhóm, tin nhắn..."
        />
      </div>

      {!q && (
        <div className="filter-tabs">
          <button
            type="button"
            className={`filter-pill ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            Tất cả ({conversations.length})
          </button>
          <button
            type="button"
            className={`filter-pill ${filter === 'risky' ? 'active' : ''}`}
            onClick={() => setFilter('risky')}
          >
            Có cảnh báo
          </button>
        </div>
      )}

      <div className="conv-list">
        {q && <div className="search-section-label">Người dùng & Nhóm ({matchedConversations.length})</div>}

        {matchedConversations.map((c) => {
          const last = c.messages[c.messages.length - 1];
          const risk = getConversationRisk(c);
          const repCount = reportCountByUser(c.peerUserId);
          const peer = c.peerUserId ? userMap.get(c.peerUserId) : undefined;
          return (
            <button
              key={c.id}
              type="button"
              className={`conv-item ${c.id === activeId ? 'active' : ''}`}
              onClick={() => onSelectConversation(c.id)}
            >
              <div className="avatar" style={{ background: c.avatarColor }}>
                {peer?.avatarUrl ? <img src={peer.avatarUrl} alt={getLabel(c)} /> : c.avatarText}
                {c.isOnline && <span className="online-dot" />}
              </div>
              <div className="conv-body">
                <div className="conv-top">
                  <span className="conv-name">{getLabel(c)}</span>
                  <span className="conv-time">{last?.timestamp ?? ''}</span>
                </div>
                <div className="conv-bottom">
                  <span className="conv-preview">
                    {last
                      ? `${last.direction === 'outgoing' ? 'Bạn: ' : ''}${last.text || '[Hình ảnh]'}`
                      : 'Chưa có tin nhắn'}
                  </span>
                  {repCount > 0 ? (
                    <span className="conv-risk-tag reported">TỐ CÁO ({repCount})</span>
                  ) : risk ? (
                    <span className={`conv-risk-tag ${risk}`}>{risk.toUpperCase()}</span>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}

        {q && matchedMessages.length > 0 && (
          <>
            <div className="search-section-label">Tin nhắn khớp ({matchedMessages.length})</div>
            {matchedMessages.slice(0, 12).map(({ conv, msg }) => (
              <button
                key={`${conv.id}-${msg.id}`}
                type="button"
                className="conv-item"
                onClick={() => {
                  onSelectConversation(conv.id, msg.id);
                  setQuery('');
                }}
              >
                <div className="avatar sm" style={{ background: conv.avatarColor }}>
                  {conv.avatarText}
                </div>
                <div className="conv-body">
                  <div className="conv-top">
                    <span className="conv-name">{getLabel(conv)}</span>
                    <span className="conv-time">{msg.timestamp}</span>
                  </div>
                  <div className="conv-preview">{msg.text}</div>
                </div>
              </button>
            ))}
          </>
        )}

        {q && matchedDirectoryUsers.length > 0 && (
          <>
            <div className="search-section-label">Danh bạ SecureChat ({matchedDirectoryUsers.length})</div>
            {matchedDirectoryUsers.map((u) => {
              const repCount = reportCountByUser(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  className="conv-item"
                  onClick={() => {
                    onStartDirectChat(u);
                    setQuery('');
                  }}
                >
                  <div className="avatar sm" style={{ background: u.avatarColor }}>
                    {u.avatarUrl ? <img src={u.avatarUrl} alt={u.displayName} /> : u.avatarText}
                  </div>
                  <div className="conv-body">
                    <div className="conv-top">
                      <span className="conv-name">{u.displayName}</span>
                      {repCount > 0 && (
                        <span className="conv-risk-tag reported">TỐ CÁO ({repCount})</span>
                      )}
                    </div>
                    <div className="conv-preview">{u.phone} · {u.email}</div>
                  </div>
                </button>
              );
            })}
          </>
        )}

        {matchedConversations.length === 0 &&
          matchedMessages.length === 0 &&
          matchedDirectoryUsers.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: '#64748b' }}>
              Không tìm thấy người dùng, SĐT, email, nhóm hay tin nhắn phù hợp.
            </div>
          )}
      </div>
    </aside>
  );
}