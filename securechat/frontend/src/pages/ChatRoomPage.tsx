import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSettings } from '../app/settings';
import type { Session } from '../app/session';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { E2eeBanner } from '../components/warnings/E2eeBanner';
import { AiStatus } from '../components/warnings/AiStatus';
import { toStoredRisk } from '../features/messages/model';
import { useMessages, useWsStatus } from '../features/messages/hooks';

export function ChatRoomPage({ session }: { session: Session }) {
  const { id = '' } = useParams();
  const { aiEnabled } = useSettings();
  const messages = useMessages(session.chat, id);
  const wsStatus = useWsStatus(session.ws);
  const readIds = useRef(new Set<string>());

  // Đánh dấu đã đọc khi đang xem tab này.
  useEffect(() => {
    if (document.visibilityState !== 'visible') return;
    void session.chat.markRead(id, readIds.current);
  }, [session, id, messages.length]);

  return (
    <main className="page room">
      <header className="topbar">
        <Link to="/" aria-label="Quay lại">
          ←
        </Link>
        <h1>Cuộc trò chuyện</h1>
        <span className="muted small">{wsStatus === 'open' ? 'Trực tuyến' : 'Ngoại tuyến'}</span>
      </header>
      <E2eeBanner crypto={session.crypto} />
      <div className="room-body">
        <MessageList messages={messages} onRetry={(mid) => void session.chat.retry(mid)} />
      </div>
      <div className="room-foot">
        <AiStatus analyzer={session.analyzer} />
        <Composer
          analyzer={session.analyzer}
          aiEnabled={aiEnabled}
          onSend={(text, a) =>
            void session.chat.sendText(id, text, a ? toStoredRisk(a) : undefined)
          }
        />
      </div>
    </main>
  );
}
