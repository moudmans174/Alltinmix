import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, AuthProvider, CartProvider, ToastProvider, ThemeProvider, WishlistProvider } from './context';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
      <ToastProvider>
        <ConfigProvider>
          <AuthProvider>
            <WishlistProvider>
            <CartProvider>
              <App />
            </CartProvider>
            </WishlistProvider>
          </AuthProvider>
        </ConfigProvider>
      </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
