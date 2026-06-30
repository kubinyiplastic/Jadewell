require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Statikus fájlok
app.use(express.static(path.join(__dirname, 'public')));

// A /uploads elérési út NEM kell többé (képek Supabase Storage-ban vannak)

// API route-ok
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/partners', require('./routes/partners'));
app.use('/api/jobs',     require('./routes/jobs'));
app.use('/api/leads',    require('./routes/leads'));
app.use('/api/quotes',   require('./routes/quotes'));
app.use('/api/admin',    require('./routes/admin'));

// Admin oldal
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Hibakezelés
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Szerver hiba' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('   JadeWell – Supabase verzió');
  console.log('========================================');
  console.log('');
  console.log(`  Szervizes felület:  http://localhost:${PORT}`);
  console.log(`  Admin felület:      http://localhost:${PORT}/admin`);
  console.log('');
});
