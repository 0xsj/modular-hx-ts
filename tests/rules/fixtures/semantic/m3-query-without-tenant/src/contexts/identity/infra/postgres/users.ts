// A repository query with no tenant filter. It does not error — it returns
// every tenant's users, which is why this needs a rule rather than a review.
export const findByEmail = 'select id, email from users where email = $1';
