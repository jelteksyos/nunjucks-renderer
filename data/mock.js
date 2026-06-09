// Mock data for templates/index.njk
// Edit this file freely — the browser will reload automatically.
//
// Fields intentionally omitted (missingField, user.avatar) to demonstrate
// that Nunjucks handles undefined values safely (renders as "").

module.exports = {
  title: 'Nunjucks Renderer',
  description: 'Edit templates/index.njk and watch the browser update instantly.',

  user: {
    name: 'Jane',
    role: 'Designer',
    // avatar is intentionally absent — {{ user.avatar | default("anon") }}
  },

  items: [
    { label: 'Apples',   count: 12 },
    { label: 'Bananas',  count: 5  },
    { label: 'Cherries', count: 34 },
  ],

  // Intentionally absent — {{ missingField | default("n/a") }}
  // missingField: 'this is hidden',
};
