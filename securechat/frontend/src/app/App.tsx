import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../features/auth/authStore';
import { BenchPage } from '../pages/BenchPage';
import { ChatListPage } from '../pages/ChatListPage';
import { ChatRoomPage } from '../pages/ChatRoomPage';
import { LoginPage } from '../pages/LoginPage';

export function App() {
  const { status, session, restore } = useAuth();
  useEffect(() => {
    void restore();
  }, [restore]);

  if (status === 'booting') return <p className="empty">Đang tải…</p>;

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes>
        <Route path="/bench" element={<BenchPage />} />
        {session ? (
          <>
            <Route path="/" element={<ChatListPage session={session} />} />
            <Route path="/c/:id" element={<ChatRoomPage session={session} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        ) : (
          <Route path="*" element={<LoginPage />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}
