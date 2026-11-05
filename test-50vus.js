import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 50,
  duration: '30s',
};

const BASE_URL = 'http://localhost:4000';
const TOKEN = __ENV.TOKEN;

export default function () {
  const res = http.get(`${BASE_URL}/api/bookings`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 2000ms': (r) => r.timings.duration < 2000,
  });

  sleep(1);
}
