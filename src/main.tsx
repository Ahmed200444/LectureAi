import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ServiceWorkerRegister } from '../components/ServiceWorkerRegister';
import '../styles/globals.css';
import '../styles/mobile-ios.css';
import LectureAI from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LectureAI />
    <ServiceWorkerRegister />
  </StrictMode>,
);