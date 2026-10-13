import './styles.css';

export const metadata = {
  title: 'Parallel Lives | Operations',
  description: 'Parallel Lives community care and moderation dashboard',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
