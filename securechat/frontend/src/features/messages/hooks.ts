import { useEffect, useState } from 'react';
import type { WsClient, WsStatus } from '../../transport/ws';
import type { Conversation } from '../../transport/types';
import type { LocalMessage } from '../../storage';
import type { ChatService } from './chatService';

export function useMessages(chat: ChatService, conversationId: string): LocalMessage[] {
  const [msgs, setMsgs] = useState<LocalMessage[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void chat.messages(conversationId).then((m) => alive && setMsgs(m));
    load();
    const off = chat.on('changed', (e) => e.conversationId === conversationId && load());
    return () => {
      alive = false;
      off();
    };
  }, [chat, conversationId]);
  return msgs;
}

export function useConversations(chat: ChatService): Conversation[] {
  const [list, setList] = useState<Conversation[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void chat.listConversations().then((c) => alive && setList(c));
    load();
    const off = chat.on('conversations', load);
    return () => {
      alive = false;
      off();
    };
  }, [chat]);
  return list;
}

export function useWsStatus(ws: WsClient): WsStatus {
  const [s, setS] = useState<WsStatus>(ws.status);
  useEffect(() => {
    setS(ws.status);
    return ws.on('status', setS);
  }, [ws]);
  return s;
}
