import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element not found');
}

const root = ReactDOM.createRoot(rootEl as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

reportWebVitals();

