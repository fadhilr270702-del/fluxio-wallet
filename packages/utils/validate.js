export function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
