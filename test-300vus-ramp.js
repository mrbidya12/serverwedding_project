import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '15s', target: 300 },   // ramp up to 300 over 15s
    { duration: '15s', target: 300 },   // hold at 300
  ],
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
