# Confidentialité — connecteur Joomil

**Projet d'annexe à la politique publique Joomil. Ne pas publier sans compléter
la section « À vérifier avant publication ».**

## À quoi sert le connecteur ?

Le connecteur Joomil permet de chercher et de consulter certaines annonces
publiques de Joomil.ch depuis un assistant compatible. Il ne nécessite pas
de compte Joomil et ne permet pas de publier, de contacter un annonceur, de
lire des messages privés ni de payer. Le responsable du traitement côté Joomil
est **Valmo Sàrl**, voir la [politique générale](https://www.joomil.ch/petitesannonces/protection-donnees/cms/85).

## Quelles données sont traitées ?

- L'assistant envoie les éléments nécessaires à chaque appel : mots-clés ou
  requête de recherche courte, catégorie, localité ou canton, budget ou ID
  d'annonce. Joomil ne demande pas l'historique de la conversation. N'inclus
  pas de mot de passe, de coordonnées personnelles ni d'information
  confidentielle dans une recherche.
- Le connecteur retourne des données publiques de l'annonce : titre,
  description, prix, localité, liens et, selon l'outil, informations publiques
  de l'annonceur et URL des photos. Il ne lit pas les champs privés du compte
  annonceur. Une description rédigée par un utilisateur peut néanmoins
  contenir des informations personnelles ; elle reste soumise à la modération
  Joomil et peut être signalée.
- Le service utilise l'adresse réseau d'entrée et, pour les anciens clients,
  un identifiant technique de session pour limiter les abus. Les clés des
  compteurs côté Worker sont dérivées par HMAC. Le Worker n'ajoute pas l'adresse
  réseau du client ni l'identifiant de session à la requête applicative vers
  l'API Joomil.

## Finalités, destinataires et droits

Les données servent à interpréter une recherche, appeler l'API Joomil,
retourner les annonces demandées et limiter l'usage abusif. Les appels passent
par Cloudflare, qui héberge le connecteur, et si nécessaire par l'API Joomil
sur son hébergement. Le fournisseur de l'assistant sélectionné transmet les
paramètres et reçoit les résultats utilisés dans la conversation ; ses
propres paramètres et conditions de confidentialité s'appliquent à cet usage.

Tu peux désactiver ou retirer le connecteur dans ton assistant, signaler une
annonce, ou contacter [l'assistance Joomil](https://support.joomil.ch/helpdesk/assistance-3)
pour exercer tes droits. Ouvrir un lien vers Joomil.ch est une navigation
sur le site, couverte par sa politique générale.

## À vérifier avant publication (note interne, à retirer de la notice)

- **Rétention effective :** pas de base de conversations ni d'historique de
  recherche gérés par le code du connecteur. L'absence d'un réglage
  `observability` dans `wrangler.toml` et dans la réponse `versions view`
  n'établit pas que les logs sont désactivés. Relever les réglages effectifs
  Cloudflare (invocations, traces, exports, rétention), la persistance du SDK
  MCP et les logs d'accès LiteSpeed (dont la query REST contenant `q`), leurs
  destinataires et délais de rotation. Écarter ou réduire les traces contenant
  des données non nécessaires ; ne pas promettre « aucun log ».
- Les fenêtres de quota observées sont de 60 secondes. Les entrées de
  l'origine de plus de 120 secondes sont supprimées lors de requêtes qui
  atteignent l'étape de nettoyage ; ce n'est pas une garantie de délai maximal
  en l'absence de trafic. Documenter la durée et le sort exact de ces
  compteurs, du cache de catégories et des états de session.
- Avant de livrer le lien aux catalogues, compléter le texte public : finalités,
  prestataires et transferts applicables, durées par catégorie de données,
  moyens d'exercer les droits. Confirmer que les champs publics répertoriés
  correspondent au périmètre finalement retenu. Ne pas reprendre la durée
  Google Analytics du site comme durée des logs MCP.
