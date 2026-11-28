export interface UserAccount {
  id: string;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  passwordHash: string;
  avatarText: string;
  avatarColor: string;
  avatarUrl?: string;
  bio: string;
  isOnline: boolean;
  createdAt: string;
}

export interface RegisterPayload {
  displayName: string;
  username: string;
  email: string;
  phone?: string;
  password: string;
}

export interface ProfileUpdatePayload {
  displayName: string;
  bio: string;
  avatarUrl?: string;
}

export interface ScamReport {
  id: string;
  targetUserId: string;
  reporterUserId: string;
  reporterName: string;
  reason: string;
  note: string;
  createdAt: string;
}

export const SCAM_REPORT_REASONS = [
  'Giả mạo ngân hàng / cơ quan chức năng',
  'Yêu cầu cung cấp mã OTP / mật khẩu',
  'Giả mạo shipper / đòi chuyển khoản trước',
  'Tuyển CTV việc nhẹ lương cao / nạp tiền làm nhiệm vụ',
  'Dẫn dụ dài ngày / lôi kéo đầu tư sàn ảo',
  'Gửi đường link hoặc mã QR độc hại',
  'Quảng cáo / spam làm phiền liên tục',
] as const;