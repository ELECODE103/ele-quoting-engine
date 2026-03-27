import React, { createContext, useState, useEffect, useCallback } from 'react';
import { setAuthToken } from './api';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setTokenState] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('authToken');
    if (savedToken) {
      setTokenState(savedToken);
      setAuthToken(savedToken);
      try {
        // Decode JWT to get user info (basic decode, no verification)
        const parts = savedToken.split('.');
        if (parts.length === 3) {
          const decoded = JSON.parse(atob(parts[1]));
          setUser(decoded);
        }
      } catch (err) {
        console.error('Failed to decode token:', err);
        localStorage.removeItem('authToken');
        setTokenState(null);
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback((newToken, userData) => {
    localStorage.setItem('authToken', newToken);
    setTokenState(newToken);
    setAuthToken(newToken);
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('authToken');
    setTokenState(null);
    setAuthToken(null);
    setUser(null);
  }, []);

  const isAuthenticated = !!token;

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
