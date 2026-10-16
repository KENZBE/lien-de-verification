# Active Cards — Supabase, GitHub et Render

Le site est servi par un petit serveur Node.js sur Render. Supabase Auth gère les comptes admin et Supabase Postgres conserve les demandes et l’adresse de réception. Les secrets Supabase et SMTP restent uniquement sur le serveur Render.

## Sécurité et fonctionnement

- Le formulaire ne demande que le type de carte, le nom, l’adresse e-mail et un message. Il refuse les mots-clés et formats de codes courants; ne jamais lui transmettre de numéro, PIN, code de recharge, solde ou photo.
- Les statuts sont administratifs et ne vérifient pas la validité ou le solde d’une carte.
- Les demandes et le réglage d’adresse sont accessibles côté base seulement par `service_role`. Le script de schéma active RLS et refuse les accès directs aux rôles `anon` et `authenticated`.
- L’administration exige un compte Supabase Auth dont l’UUID est inscrit dans `SUPABASE_ADMIN_USER_IDS`.
- Pour chaque dossier, l’admin rédige une réponse dans le formulaire associé. En cliquant sur un bouton d’état, ce texte est enregistré comme dernier reçu du dossier et envoyé au client avec sa référence et le statut administratif. Les réponses ne doivent pas évaluer une carte, indiquer un prix ou demander un code/identifiant.
- L’envoi des reçus par e-mail demande un fournisseur SMTP transactionnel en plus de Supabase.

## Configuration Supabase

1. Créez un projet Supabase.
2. Dans **SQL Editor**, exécutez le fichier [`supabase/schema.sql`](./supabase/schema.sql). Si vous aviez déjà créé les tables, réexécutez le script : il ajoute de façon compatible la colonne `admin_response` pour conserver le dernier reçu envoyé.
3. Dans **Authentication > Users**, créez le compte admin avec son adresse e-mail et un mot de passe unique. Copiez son UUID et ajoutez-le à `SUPABASE_ADMIN_USER_IDS`. Pour plusieurs admins, séparez les UUID par des virgules.
4. Récupérez l’URL du projet et sa clé `anon`/publishable dans les paramètres API.
5. Récupérez la clé `service_role` / secret côté projet. Cette clé contourne RLS : ne la mettez jamais dans `public/`, dans GitHub côté client, ni dans un fichier livré au navigateur.

## Déploiement GitHub + Render

1. Poussez les fichiers du projet dans un dépôt GitHub privé.
2. Dans Render, créez un **Blueprint** relié à ce dépôt. Le fichier `render.yaml` configure uniquement le service Node; les données restent dans le projet Supabase.
3. Renseignez dans les variables privées Render :
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_ADMIN_USER_IDS`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
4. Ouvrez `/admin`, connectez-vous avec le compte Supabase Auth autorisé, puis définissez l’adresse qui recevra les nouvelles demandes.
5. Testez une demande et chaque état avec des adresses e-mail que vous contrôlez. Publiez en HTTPS avant toute utilisation.

Les demandes sont enregistrées dans Supabase même si SMTP n’est pas configuré ; le formulaire indique explicitement quand l’e-mail de notification n’a pas été envoyé. La connexion admin et les données ne fonctionnent pas avant d’avoir configuré Supabase et exécuté le schéma SQL.

## Exécution locale

Prérequis : Node.js 20+.

Définissez les variables Supabase et SMTP ci-dessus dans l’environnement, puis lancez :

```sh
npm install
npm start
```

`GET /health` vérifie l’accès aux tables Supabase.
