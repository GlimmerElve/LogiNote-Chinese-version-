import { useEffect, useState } from 'react';
import { homeLocalDate } from '../services/homepage/homeTaskScheduling';

/** Refresh date-sensitive views across midnight and after returning to the app. */
export function useLocalCalendarDate(): string {
  const [today, setToday] = useState(homeLocalDate);
  useEffect(() => {
    const refresh = () => setToday(homeLocalDate());
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return today;
}
