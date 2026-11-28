// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble, statusLabel } from '../../src/components/chat/MessageBubble';
import type { LocalMessage } from '../../src/storage';

afterEach(cleanup);
const base: LocalMessage = {
  id: '1',
  clientMessageId: '1',
  conversationId: 'c',
  senderId: 'u',
  direction: 'in',
  text: 'xin chào',
  status: 'received',
  createdAt: '2026-01-01T10:00:00Z',
};

describe('MessageBubble', () => {
  it('tin nhận có cảnh báo scam', () => {
    render(
      <ul>
        <MessageBubble m={{ ...base, risk: { level: 'warn', label: 'scam' } }} />
      </ul>,
    );
    expect(screen.getByText('xin chào')).toBeTruthy();
    expect(screen.getByText(/lừa đảo/)).toBeTruthy();
  });
  it('tin nhận sạch: không hiện bất kỳ nhãn an toàn/cảnh báo nào', () => {
    render(
      <ul>
        <MessageBubble m={{ ...base, risk: { level: 'none', label: 'benign' } }} />
      </ul>,
    );
    expect(screen.queryByLabelText('Cảnh báo an toàn')).toBeNull();
    expect(screen.queryByText(/an toàn/i)).toBeNull();
  });
  it('tin không giải mã được hiển thị lý do, không để trống', () => {
    render(
      <ul>
        <MessageBubble
          m={{ ...base, text: null, status: 'undecryptable', error: 'Không đọc được' }}
        />
      </ul>,
    );
    expect(screen.getByText('Không đọc được')).toBeTruthy();
  });
  it('tin gửi lỗi có nút Thử lại; lỗi vĩnh viễn thì không', () => {
    const onRetry = vi.fn();
    const out: LocalMessage = {
      ...base,
      direction: 'out',
      status: 'failed',
      error: 'mạng',
      pending: { ciphertext: 'AA==', protocolMeta: {} },
    };
    const { rerender } = render(
      <ul>
        <MessageBubble m={out} onRetry={onRetry} />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledWith('1');
    rerender(
      <ul>
        <MessageBubble
          m={{ ...out, pending: { ...out.pending!, permanentFailure: true } }}
          onRetry={onRetry}
        />
      </ul>,
    );
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  });
  it('nhãn trạng thái', () => {
    expect(statusLabel({ direction: 'out', status: 'read' })).toBe('Đã xem');
    expect(statusLabel({ direction: 'in', status: 'received' })).toBe('');
  });
});
