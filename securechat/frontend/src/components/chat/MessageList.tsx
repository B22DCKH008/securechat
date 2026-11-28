import { useEffect, useRef } from 'react';
import type { LocalMessage } from '../../storage';
import { MessageBubble } from './MessageBubble';

export function MessageList({
  messages,
  onRetry,
}: {
  messages: LocalMessage[];
  onRetry(id: string): void;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);

  if (messages.length === 0)
    return <p className="empty">Chưa có tin nhắn. Hãy gửi lời chào đầu tiên.</p>;
  return (
    <ul className="messages" aria-live="polite">
      {messages.map((m) => (
        <MessageBubble key={m.id} m={m} onRetry={onRetry} />
      ))}
      <li ref={endRef} aria-hidden="true" />
    </ul>
  );
}
