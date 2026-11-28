import { MockCryptoProvider } from './mockProvider';
import { SignalCryptoProvider } from './signalProvider';
import type { CryptoProvider } from './types';

export type { CryptoProvider, PeerRef, EncryptedMessage } from './types';
export { DecryptError } from './types';

/** Chọn theo VITE_E2EE ('mock' mặc định | 'signal'). */
export function createCryptoProvider(
  kind: string | undefined = import.meta.env.VITE_E2EE,
): CryptoProvider {
  return kind === 'signal' ? new SignalCryptoProvider() : new MockCryptoProvider();
}
