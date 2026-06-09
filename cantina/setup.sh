#!/bin/bash
# Script de inicialização rápida do CantinaSmart

echo "🍽️  CantinaSmart - Inicialização Rápida"
echo "======================================="
echo ""

# Verificar se config.js existe
if [ ! -f "config.js" ]; then
    echo "⚠️  config.js não encontrado!"
    echo ""
    echo "Criando config.js a partir do template..."
    cp config.example.js config.js
    echo "✅ config.js criado!"
    echo ""
    echo "📝 PRÓXIMO PASSO: Editar config.js com suas credenciais Firebase"
    echo "   Abra o arquivo e preencha os valores:"
    echo "   - apiKey"
    echo "   - authDomain"
    echo "   - projectId"
    echo "   - storageBucket"
    echo "   - messagingSenderId"
    echo "   - appId"
    echo ""
    echo "Você pode pegar essas informações em:"
    echo "https://console.firebase.google.com → Configurações do Projeto → Seus Apps"
    exit 1
fi

echo "✅ config.js encontrado!"
echo ""

# Verificar se .gitignore existe
if [ ! -f ".gitignore" ]; then
    echo "⚠️  .gitignore não encontrado. Criando..."
    cat > .gitignore << EOF
config.js
node_modules/
.DS_Store
*.log
EOF
    echo "✅ .gitignore criado!"
else
    echo "✅ .gitignore encontrado!"
fi

echo ""
echo "🚀 CantinaSmart pronto para usar!"
echo ""
echo "Próximos passos:"
echo "1. Abra index-new.html no navegador"
echo "2. Crie uma conta (Email/Senha)"
echo "3. Comece a usar!"
echo ""
echo "Para colocar online:"
echo ""
echo "  Netlify (recomendado):"
echo "  $ cd cantina-escolar"
echo "  $ Arraste a pasta para netlify.com"
echo ""
echo "  Vercel:"
echo "  $ vercel --prod"
echo ""
echo "  Firebase Hosting:"
echo "  $ firebase deploy --only hosting"
echo ""
echo "Documentação:"
echo "- LEIA-ME-v2.md"
echo "- DEPLOYMENT-CHECKLIST.md"
echo "- MELHORIAS-IMPLEMENTADAS.md"
