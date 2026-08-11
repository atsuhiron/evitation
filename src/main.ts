import './ui/styles.css';
import { startRouter } from './router.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('#app が見つかりません');
}

startRouter(app);
