# Joomil — dossier de soumission aux catalogues

**Brouillon local, au 27.11.2026.** Aucun fichier téléversé, aucune soumission,
aucune modification du serveur ou du classement. Ce dossier ne concerne ni la
fiche Business Hub ni la mise à jour du MCP Registry.

## Choix de périmètre avant envoi

- **Modération Joomil :** reclasser, retirer ou masquer une annonce mal classée
  à la source, via la modération et les signalements existants. Le MCP ne
  tranche pas la conformité éditoriale. Ne pas créer de seconde file de
  modération, de classifieur IA ou de filtre à mots isolés.
- **MCP :** appliquer le périmètre des catalogues de façon identique à la
  recherche et au détail, y compris par ID. La v1.3.3 exclut 30 catégories
  (descendantes comprises), ainsi que les annonces périmées. Cela n'atteste ni
  l'admissibilité d'une annonce mal classée ni celle de toutes les autres rubriques.
- **Inventaire grand public :** OpenAI demande un service adapté aux 13–17 ans
  et interdit de faciliter les biens ou services listés, même sans achat
  intégré. Au contrôle en lecture du 27.11, l'API de la v1.3.3 retournait
  notamment 4 résultats actifs classés *Tir sportif* (`10233`), et 41 classés
  *Massages* (`10100`). Ces comptages ne qualifient pas leur contenu.
  Périmètre retenu pour la préparation : une version complète, pas un pilote
  limité à quelques rubriques. Garder toutes les rubriques admissibles ; auditer
  les rubriques mixtes et appliquer les exclusions requises avant total et
  pagination, dans la recherche comme au détail. La modération source traite
  les annonces mal classées ; le connecteur ne fait pas de modération parallèle.
- **STAR/FLASH :** Anthropic exclut publicités, contenus sponsorisés et
  placements payants sans permission écrite ; OpenAI interdit de servir des
  publicités. Une petite annonce ordinaire ne se confond pas automatiquement
  avec un placement. Le 27.11, l'origine a renvoyé deux FLASH sur 40 résultats
  automobiles et trois STAR sur 30 résultats triés par vues.
  La recherche MCP ne renvoie pas le champ `boost`, mais le détail le fait.
  Le code d'activation STAR/FLASH réécrit `ad_date` ; le tri `recent` du MCP
  utilise cette date. Il existe donc un effet de remontée même sans badge.
  Direction retenue pour la préparation : ne pas exclure une annonce au seul
  motif qu'elle est boostée sur le site. La rendre éligible aux mêmes conditions
  qu'une autre annonce et supprimer l'avantage payé dans les résultats du MCP.
  Ne pas attester « sans contenu sponsorisé » avant d'avoir vérifié le
  comportement et clarifié avec les catalogues comment déclarer les annonces
  boostées uniquement sur Joomil.ch.
- **Recette de sécurité :** vérifier les refus par catégorie et par ID,
  un reclassement ou retrait à la source, les liens de détail, ainsi que
  les textes libres (coordonnées, liens publicitaires et instructions dans
  une description). Échantillonner quelques rubriques autorisées ; pour
  tester les cas négatifs, utiliser des fiches fictives en recette. Ne pas
  recopier d'annonces litigieuses ou de données personnelles dans le dossier.
  Examiner aussi la pertinence du texte intégral et des champs vendeur/images.

### Proposition technique — classement organique

1. Calculer le tri **à l'origine, avant `LIMIT` et `OFFSET`**. Avec des mots-clés,
   l'API dispose déjà d'un score textuel sur titre, description et catégorie
   indépendant du boost. Garder les tris de prix, départager les ex æquo par
   un critère stable non payé, comme l'ID d'annonce. Sans mots-clés ni prix,
   utiliser un ordre neutre et le nommer honnêtement. Ne pas présenter un ID
   comme une date de publication.
2. Ne pas utiliser `ad_date`, réécrite par les remontées STAR/FLASH, pour
   prétendre trier par date d'origine. Préserver un vrai tri chronologique
   seulement si une date indépendante de la remontée peut être vérifiée.
   Ne pas s'appuyer sur le tri `views` tant que vues et impressions peuvent
   refléter une visibilité payée ; définir une transition explicite des
   anciens tris et champs avant de changer le contrat.
3. Ne pas afficher de badge STAR/FLASH dans le résultat du catalogue, ni de
   CTA d'achat de boost. L'URL d'origine reste celle de l'annonce. Le tri
   neutre ne modifie pas la durée de publication sur le site : un boost peut
   prolonger l'activité et donc l'éligibilité d'une annonce. Le signaler au
   reviewer séparément du classement ; ne pas promettre que le paiement
   n'a aucun effet sur l'inventaire.
4. Tester sur des fiches fictives identiques, avec et sans boost : modifier
   flags, date de remontée et impressions sans changer leur éligibilité ;
   vérifier que résultats, ordre, pages et totaux restent identiques aux
   tris annoncés, y compris en cas d'ex æquo. Vérifier que les annonces
   éligibles boostées restent accessibles par ID, sans métadonnée de boost.
   Préserver les tris et pages du site et du REST par défaut.

Sources du 27.11.2026 : [Anthropic Software Directory Policy, §§1, 3, 4.C–D](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy),
[Claude Connector review](https://claude.com/docs/connectors/building/review-criteria),
[OpenAI Plugin Guidelines, §§3.2, 4, 5.2, 5.4](https://developers.openai.com/plugins/plugin-guidelines).

## Claude — reprendre la soumission existante

1. Dans le [portail Claude](https://claude.ai/directory/manage), retrouver
   le dossier **Joomil** soumis le **27.03.2026** (historique Cortex #445).
   Relever statut, feedback, organisation et éventuellement URL publique.
   Ne pas démarrer une deuxième fiche. Si la soumission est introuvable
   avec le bon compte, demander à `mcp-review@anthropic.com` de la retrouver,
   d'après le [guide des statuts](https://claude.com/docs/directory/submission-status#mcp-connector-statuses).
   Les recherches mail ciblées du 27.11 n'ont pas retrouvé de décision liée
   au dossier. Une capture du compte connecté, fournie le même jour, montre
   « Nothing submitted yet » dans le portail. Cela ne réconcilie pas le dossier
   historique : le compte ou l'organisation de la soumission initiale et une
   éventuelle trace hors du portail actuel ne sont pas vérifiés.
2. Confirmer dans ce dossier comment déclarer les petites annonces et les
   mises en avant du site. Le formulaire **Data handling** demande notamment
   si le service traite du contenu sponsorisé. Ne pas répondre à cette
   question avant d'avoir arrêté le périmètre et vérifié la réalité.
   Question de clarification (non envoyée) : “May a read-only classifieds
   connector include otherwise eligible listings that receive paid boosts
   on our website, if the connector does not display those boosts or use
   them in ranking? The website may extend a listing’s active period when
   a boost is purchased; how should this be declared in Data handling?”
3. Préparer la fiche :
   - **Nom :** Joomil.
   - **Accroche :** Rechercher des petites annonces publiques en Suisse.
   - **Description :** « Recherche des annonces Joomil.ch par catégorie,
     canton, mot-clé et budget. Consulte les prix et les liens vers les
     annonces actives couvertes. Le connecteur est en lecture seule, sans
     compte ni paiement. Publier, contacter un annonceur ou effectuer une
     transaction ne se fait pas dans le connecteur. »
   - **Éditeur :** Valmo Sàrl ; site `https://www.joomil.ch/` ;
     [assistance Joomil](https://support.joomil.ch/helpdesk/assistance-3).
   - **Documentation :** [README public du MCP](https://github.com/Valmo-Sarl/joomil-mcp#readme),
     à mettre à jour avant publication ; aucun commit ou push compris dans la
     préparation. **Confidentialité :** URL Joomil publiée et complétée après
     validation de l'[annexe MCP](privacy-fr.md). **Icône :** logo carré Joomil.
   - **API :** propriétaire, HTTPS distant, Streamable HTTP, pas de compte de
     test ni de clé côté utilisateurs. Pas d'interface interactive
     ni de `ui/open-link` ; les outils retournent des liens d'annonces.
4. Exemples : « Trouve des vélos dans le canton de Vaud sous CHF 500 » ;
   « Quel identifiant utiliser pour la catégorie Vélos ? » ;
   « Ouvre cette annonce Joomil et indique son prix et sa localité ».
   Rejouer les cinq outils sur le périmètre finalement retenu.

## ChatGPT / Codex — brouillon du plugin portable

Le dossier [`openai/`](openai/) contient le manifeste, un seul serveur MCP
et l'icône, sans skill, hook, clé ni source Worker. Les cinq cas positifs et
les trois négatifs sont dans le manifeste. Ce ZIP local permet de relire le
contenu ; **ne pas l'envoyer tel quel**.

1. Vérifier qu'aucun dossier Joomil n'existe dans [Plugins](https://platform.openai.com/plugins)
   pour l'organisation et le projet Valmo. Confirmer l'identité d'éditeur
   Valmo Sàrl et la catégorie de fiche dans le portail. Le classement proposé
   dans le manifeste est provisoire.
2. Décider le nom HTTPS définitif avant l'upload. Le guide OpenAI demande
   de servir le challenge exact à `/.well-known/openai-apps-challenge`
   sur l'hôte MCP ou un parent admissible ; une URL MCP déjà connectée ne
   se change pas librement. `mcp.joomil.ch` est un **candidat**, pas une
   configuration active. Anthropic recommande aussi un domaine qui correspond
   au service. Aucun DNS ou challenge n'a été ajouté. Le manifeste de travail
   pointe vers le `workers.dev` testé.
3. Publier la notice MCP après vérification des données et de leur rétention ;
   utiliser son URL dans le manifeste. Le lien actuel pointe seulement vers
   la politique générale publiée. Vérifier également les CGU et le support.
4. Rejouer les huit cas dans le client sur l'endpoint définitif et préparer
   une vidéo accessible au reviewer, sans compte membre ni information
   privée à l'écran. Un parcours simple : catégorie → canton → suggestion
   → recherche → détail d'une annonce active, puis refus d'une annonce
   expirée, d'un budget inversé et d'une catégorie hors périmètre. Mettre à
   jour les IDs de test si nécessaire. Ajouter l'URL publique de la vidéo
   (`review.demo_recording_url`) avant l'envoi ; elle est volontairement
   absente du brouillon.
5. Après validation humaine : ZIP avec `plugin.json`, `mcp.json` et
   `assets/` à la racine ; ouvrir **MCPs → Connect**, vérifier le domaine,
   lire les résultats du scan, puis compléter le dossier de revue.
   Choisir **Sans authentification** dans le portail si demandé ; le format
   portable du brouillon est un endpoint HTTPS sans credentials ni en-têtes.
   **Soumettre**, puis **publier après approbation**, sont deux actions distinctes.

[Guide de soumission OpenAI](https://developers.openai.com/plugins/deploy/submission) ·
[Guide Claude](https://claude.com/docs/connectors/building/submission).
