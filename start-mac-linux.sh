#!/bin/bash
echo ""
echo "========================================"
echo "   JadeWell szerver indítása"
echo "========================================"
echo ""
echo "Ha ez az első indítás, futtasd először:"
echo "   npm install"
echo "   npm run init-db"
echo ""
echo "A szerver leállítása: Ctrl+C"
echo ""
read -p "Nyomj Entert a folytatáshoz..."
npm start
