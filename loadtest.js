import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 200 },
    { duration: '2m', target: 500 },
    { duration: '30s', target: 0 },
  ],
};

export default function () {
  const payload = JSON.stringify({
    email: 'test@example.com',
    password: `wrong${Math.random()}`,
  });
  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  const res = http.post('http://localhost:4000/api/users/login', payload, params);

  check(res, {
    'status is 401 or 429': (r) => r.status === 401 || r.status === 429,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(0.1);
}
