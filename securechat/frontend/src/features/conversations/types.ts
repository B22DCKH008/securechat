import type { MessageAnalysis } from '../../ai/contract';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  direction: 'outgoing' | 'incoming';
  text: string;
  timestamp: string;
  deliveryStatus?: 'sent' | 'delivered' | 'read';
  analysis: MessageAnalysis;
  matchedRules?: string[];
  imageUrl?: string;
  imageName?: string;
  qrPayloads?: string[];
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  peerUserId?: string;
  name: string;
  avatarText: string;
  avatarColor: string;
  subtitle: string;
  isOnline: boolean;
  isStranger?: boolean;
  messages: ChatMessage[];
}