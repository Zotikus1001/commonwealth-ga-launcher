import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import RendererErrorBoundary from './components/RendererErrorBoundary';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
);
