// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from '../../src/components/chat/Composer';
import type { ControllableAnalyzer } from '../../src/ai';

afterEach(cleanup);

function fakeAnalyzer(over: Partial<ControllableAnalyzer> = {}): ControllableAnalyzer {
  return {
    init: async () => {},
    analyzeMessage: async () => ({
      status: 'ok',
      label: 'benign',
      confidence: 0.95,
      modelVersion: 'v',
      latencyMs: 1,
    }),
    analyzeUrl: async (url) => ({
      status: 'ok',
      url,
      label: 'benign',
      confidence: 0.9,
      modelVersion: 'u',
      latencyMs: 1,
    }),
    getState: () => ({ phase: 'ready' }),
    subscribe: () => () => {},
    setEnabled: () => {},
    retryInit: async () => {},
    ...over,
  };
}

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText('Nhập tin nhắn'), { target: { value: text } });

describe('Composer', () => {
  it('tin bình thường: gửi thẳng, xóa ô nhập', async () => {
    const onSend = vi.fn();
    render(<Composer analyzer={fakeAnalyzer()} aiEnabled onSend={onSend} />);
    type('chào bạn');
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0]![0]).toBe('chào bạn');
    expect((screen.getByLabelText('Nhập tin nhắn') as HTMLTextAreaElement).value).toBe('');
  });

  it('AI phát hiện scam: hỏi lại; "Sửa lại" không gửi, "Vẫn gửi" mới gửi', async () => {
    const onSend = vi.fn();
    const a = fakeAnalyzer({
      analyzeMessage: async () => ({
        status: 'ok',
        label: 'scam',
        confidence: 0.9,
        modelVersion: 'v',
        latencyMs: 1,
      }),
    });
    render(<Composer analyzer={a} aiEnabled onSend={onSend} />);
    type('trúng thưởng, bấm vào link');
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Sửa lại' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Vẫn gửi' }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('dữ liệu nhạy cảm (OTP) bị chặn hỏi lại dù AI tắt/lỗi', async () => {
    const a = fakeAnalyzer({ analyzeMessage: async () => ({ status: 'unavailable' }) });
    render(<Composer analyzer={a} aiEnabled onSend={vi.fn()} />);
    type('mã otp của mình là 482913');
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('AI lỗi/quá hạn KHÔNG chặn gửi tin bình thường', async () => {
    const onSend = vi.fn();
    const a = fakeAnalyzer({ analyzeMessage: async () => ({ status: 'timeout' }) });
    render(<Composer analyzer={a} aiEnabled onSend={onSend} />);
    type('hẹn 7h nhé');
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('tắt AI: gửi thẳng, không gọi analyzer', async () => {
    const analyze = vi.fn(async () => ({
      status: 'ok' as const,
      label: 'scam' as const,
      confidence: 1,
      modelVersion: 'v',
      latencyMs: 1,
    }));
    const onSend = vi.fn();
    render(
      <Composer
        analyzer={fakeAnalyzer({ analyzeMessage: analyze })}
        aiEnabled={false}
        onSend={onSend}
      />,
    );
    type('abc');
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(analyze).not.toHaveBeenCalled();
  });

  it('Enter gửi, Shift+Enter không gửi, Enter khi đang gõ IME (Telex) không gửi', async () => {
    const onSend = vi.fn();
    render(<Composer analyzer={fakeAnalyzer()} aiEnabled={false} onSend={onSend} />);
    const ta = screen.getByLabelText('Nhập tin nhắn');
    type('xin chào');
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  });

  it('không gửi tin rỗng/chỉ khoảng trắng', () => {
    const onSend = vi.fn();
    render(<Composer analyzer={fakeAnalyzer()} aiEnabled={false} onSend={onSend} />);
    type('   ');
    expect((screen.getByRole('button', { name: 'Gửi' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
