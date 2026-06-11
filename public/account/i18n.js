/* RallyPoint site-i18n voor de account-pagina's.
 *
 * Gebruik in HTML:
 *   <span data-i18n="login.h1">Inloggen</span>      -> textContent
 *   <input data-i18n-ph="login.emailPh">            -> placeholder
 *   <span data-i18n-html="x">..</span>              -> innerHTML (voor <b> etc.)
 *
 * In JS:  RP.t('key'), RP.setLang('en'), RP.lang
 *
 * Taalresolutie: localStorage('rallypointLang') -> <html lang> -> 'nl'.
 * Voor ingelogde gebruikers is de server (DB) de bron van waarheid: pagina's
 * die /api/auth/me ophalen roepen RP.setLang(serverLang, true) aan om te syncen.
 */
(function () {
  var LANGS = ['nl', 'en', 'de', 'es', 'fr'];
  var LANG_NAMES = { nl: 'Nederlands', en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français' };

  var S = {
    // --- Navigatie / footer (gedeeld) ---
    'nav.dashboard': { nl:'Dashboard', en:'Dashboard', de:'Dashboard', es:'Panel', fr:'Tableau de bord' },
    'nav.profile':   { nl:'Profiel', en:'Profile', de:'Profil', es:'Perfil', fr:'Profil' },
    'nav.settings':  { nl:'Instellingen', en:'Settings', de:'Einstellungen', es:'Ajustes', fr:'Réglages' },
    'nav.scoreboard':{ nl:'Scorebord →', en:'Scoreboard →', de:'Anzeigetafel →', es:'Marcador →', fr:'Tableau →' },
    'nav.home':{ nl:'Home', en:'Home', de:'Startseite', es:'Inicio', fr:'Accueil' },
    'foot.about':    { nl:'Over', en:'About', de:'Über', es:'Acerca de', fr:'À propos' },
    'foot.privacy':  { nl:'Privacy', en:'Privacy', de:'Datenschutz', es:'Privacidad', fr:'Confidentialité' },
    'foot.terms':    { nl:'Voorwaarden', en:'Terms', de:'Bedingungen', es:'Términos', fr:'Conditions' },
    'common.email':  { nl:'E-mailadres', en:'Email', de:'E-Mail-Adresse', es:'Correo electrónico', fr:'Adresse e-mail' },
    'common.password':{ nl:'Wachtwoord', en:'Password', de:'Passwort', es:'Contraseña', fr:'Mot de passe' },
    'common.langLabel':{ nl:'Taal', en:'Language', de:'Sprache', es:'Idioma', fr:'Langue' },
    'err.network':   { nl:'Netwerkfout.', en:'Network error.', de:'Netzwerkfehler.', es:'Error de red.', fr:'Erreur réseau.' },

    // --- Signup ---
    'signup.h1':       { nl:'Account aanmaken', en:'Create account', de:'Konto erstellen', es:'Crear cuenta', fr:'Créer un compte' },
    'signup.sub':      { nl:'Eén account voor al je watches en stats.', en:'One account for all your watches and stats.', de:'Ein Konto für alle deine Uhren und Statistiken.', es:'Una cuenta para todos tus relojes y estadísticas.', fr:'Un compte pour toutes vos montres et statistiques.' },
    'signup.pwPh':     { nl:'Minimaal 8 tekens', en:'At least 8 characters', de:'Mindestens 8 Zeichen', es:'Mínimo 8 caracteres', fr:'Au moins 8 caractères' },
    'signup.submit':   { nl:'Account aanmaken', en:'Create account', de:'Konto erstellen', es:'Crear cuenta', fr:'Créer un compte' },
    'signup.haveAccount':{ nl:'Heb je al een account?', en:'Already have an account?', de:'Hast du schon ein Konto?', es:'¿Ya tienes una cuenta?', fr:'Vous avez déjà un compte ?' },
    'signup.login':    { nl:'Inloggen', en:'Log in', de:'Anmelden', es:'Iniciar sesión', fr:'Se connecter' },
    'signup.err.taken':{ nl:'Dit e-mailadres is al in gebruik.', en:'This email is already in use.', de:'Diese E-Mail-Adresse wird bereits verwendet.', es:'Este correo ya está en uso.', fr:'Cette adresse e-mail est déjà utilisée.' },
    'signup.err.email':{ nl:'Ongeldig e-mailadres.', en:'Invalid email address.', de:'Ungültige E-Mail-Adresse.', es:'Correo no válido.', fr:'Adresse e-mail non valide.' },
    'signup.err.pw':   { nl:'Wachtwoord moet minstens 8 tekens zijn.', en:'Password must be at least 8 characters.', de:'Das Passwort muss mindestens 8 Zeichen lang sein.', es:'La contraseña debe tener al menos 8 caracteres.', fr:'Le mot de passe doit comporter au moins 8 caractères.' },
    'signup.err.fail': { nl:'Aanmaken mislukt.', en:'Sign-up failed.', de:'Erstellen fehlgeschlagen.', es:'No se pudo crear.', fr:'Échec de la création.' },

    // --- Login ---
    'login.h1':   { nl:'Inloggen', en:'Log in', de:'Anmelden', es:'Iniciar sesión', fr:'Se connecter' },
    'login.sub':  { nl:'Welkom terug.', en:'Welcome back.', de:'Willkommen zurück.', es:'Bienvenido de nuevo.', fr:'Bon retour.' },
    'login.submit':{ nl:'Inloggen', en:'Log in', de:'Anmelden', es:'Iniciar sesión', fr:'Se connecter' },
    'login.forgot':{ nl:'Wachtwoord vergeten?', en:'Forgot password?', de:'Passwort vergessen?', es:'¿Olvidaste tu contraseña?', fr:'Mot de passe oublié ?' },
    'login.newHere':{ nl:'Nieuw hier?', en:'New here?', de:'Neu hier?', es:'¿Nuevo aquí?', fr:'Nouveau ?' },
    'login.signup':{ nl:'Account aanmaken', en:'Create account', de:'Konto erstellen', es:'Crear cuenta', fr:'Créer un compte' },
    'login.err.creds':{ nl:'E-mail of wachtwoord klopt niet.', en:'Email or password is incorrect.', de:'E-Mail oder Passwort ist falsch.', es:'Correo o contraseña incorrectos.', fr:'E-mail ou mot de passe incorrect.' },
    'login.err.fail':{ nl:'Inloggen mislukt.', en:'Log-in failed.', de:'Anmeldung fehlgeschlagen.', es:'Error al iniciar sesión.', fr:'Échec de la connexion.' },

    // --- Forgot ---
    'forgot.h1':  { nl:'Wachtwoord vergeten', en:'Forgot password', de:'Passwort vergessen', es:'Olvidé mi contraseña', fr:'Mot de passe oublié' },
    'forgot.sub': { nl:'We sturen een resetlink naar je e-mailadres. De link is 1 uur geldig.', en:'We\'ll send a reset link to your email. The link is valid for 1 hour.', de:'Wir senden einen Reset-Link an deine E-Mail. Der Link ist 1 Stunde gültig.', es:'Te enviaremos un enlace de restablecimiento. El enlace es válido por 1 hora.', fr:'Nous enverrons un lien de réinitialisation à votre e-mail. Le lien est valable 1 heure.' },
    'forgot.submit':{ nl:'Stuur resetlink', en:'Send reset link', de:'Reset-Link senden', es:'Enviar enlace', fr:'Envoyer le lien' },
    'forgot.success':{ nl:'Als dit e-mailadres bekend is, krijg je binnen enkele minuten een mail.', en:'If this email is known, you\'ll receive a message within a few minutes.', de:'Wenn diese E-Mail bekannt ist, erhältst du innerhalb weniger Minuten eine Nachricht.', es:'Si este correo está registrado, recibirás un mensaje en unos minutos.', fr:'Si cette adresse est connue, vous recevrez un message dans quelques minutes.' },
    'forgot.back':{ nl:'Terug naar inloggen', en:'Back to login', de:'Zurück zur Anmeldung', es:'Volver al inicio de sesión', fr:'Retour à la connexion' },

    // --- Reset ---
    'reset.h1':  { nl:'Nieuw wachtwoord', en:'New password', de:'Neues Passwort', es:'Nueva contraseña', fr:'Nouveau mot de passe' },
    'reset.sub': { nl:'Daarna log je opnieuw in.', en:'Then log in again.', de:'Danach meldest du dich erneut an.', es:'Luego inicia sesión de nuevo.', fr:'Ensuite, reconnectez-vous.' },
    'reset.label':{ nl:'Nieuw wachtwoord', en:'New password', de:'Neues Passwort', es:'Nueva contraseña', fr:'Nouveau mot de passe' },
    'reset.submit':{ nl:'Wachtwoord opslaan', en:'Save password', de:'Passwort speichern', es:'Guardar contraseña', fr:'Enregistrer' },
    'reset.err.noToken':{ nl:'Ongeldige resetlink.', en:'Invalid reset link.', de:'Ungültiger Reset-Link.', es:'Enlace de restablecimiento no válido.', fr:'Lien de réinitialisation non valide.' },
    'reset.err.invalid':{ nl:'Deze link is verlopen of ongeldig.', en:'This link has expired or is invalid.', de:'Dieser Link ist abgelaufen oder ungültig.', es:'Este enlace ha caducado o no es válido.', fr:'Ce lien a expiré ou n\'est pas valide.' },
    'reset.err.fail':{ nl:'Reset mislukt.', en:'Reset failed.', de:'Zurücksetzen fehlgeschlagen.', es:'No se pudo restablecer.', fr:'Échec de la réinitialisation.' },

    // --- Settings ---
    'set.lang.h1':  { nl:'Taal', en:'Language', de:'Sprache', es:'Idioma', fr:'Langue' },
    'set.lang.sub': { nl:'Taal van de hele site. Wordt direct toegepast.', en:'Language for the whole site. Applied immediately.', de:'Sprache der gesamten Website. Wird sofort angewendet.', es:'Idioma de todo el sitio. Se aplica al instante.', fr:'Langue de tout le site. Appliquée immédiatement.' },
    'set.lang.saved':{ nl:'Taal opgeslagen', en:'Language saved', de:'Sprache gespeichert', es:'Idioma guardado', fr:'Langue enregistrée' },
    'set.pw.h1':  { nl:'Wachtwoord wijzigen', en:'Change password', de:'Passwort ändern', es:'Cambiar contraseña', fr:'Changer le mot de passe' },
    'set.pw.sub': { nl:'Na opslaan blijven andere apparaten ingelogd.', en:'Other devices stay logged in after saving.', de:'Andere Geräte bleiben nach dem Speichern angemeldet.', es:'Otros dispositivos siguen conectados tras guardar.', fr:'Les autres appareils restent connectés après l\'enregistrement.' },
    'set.pw.cur': { nl:'Huidig wachtwoord', en:'Current password', de:'Aktuelles Passwort', es:'Contraseña actual', fr:'Mot de passe actuel' },
    'set.pw.new': { nl:'Nieuw wachtwoord', en:'New password', de:'Neues Passwort', es:'Nueva contraseña', fr:'Nouveau mot de passe' },
    'set.pw.newPh':{ nl:'Min 8 tekens', en:'Min 8 characters', de:'Min. 8 Zeichen', es:'Mín 8 caracteres', fr:'Min 8 caractères' },
    'set.pw.submit':{ nl:'Wachtwoord opslaan', en:'Save password', de:'Passwort speichern', es:'Guardar contraseña', fr:'Enregistrer' },
    'set.pw.ok':  { nl:'Wachtwoord gewijzigd', en:'Password changed', de:'Passwort geändert', es:'Contraseña cambiada', fr:'Mot de passe modifié' },
    'set.pw.errCur':{ nl:'Huidig wachtwoord klopt niet.', en:'Current password is incorrect.', de:'Aktuelles Passwort ist falsch.', es:'La contraseña actual no es correcta.', fr:'Le mot de passe actuel est incorrect.' },
    'set.pw.errNew':{ nl:'Nieuw wachtwoord moet minstens 8 tekens zijn.', en:'New password must be at least 8 characters.', de:'Das neue Passwort muss mindestens 8 Zeichen lang sein.', es:'La nueva contraseña debe tener al menos 8 caracteres.', fr:'Le nouveau mot de passe doit comporter au moins 8 caractères.' },
    'set.pw.errFail':{ nl:'Opslaan mislukt.', en:'Save failed.', de:'Speichern fehlgeschlagen.', es:'Error al guardar.', fr:'Échec de l\'enregistrement.' },
    'set.em.h1':  { nl:'E-mailadres wijzigen', en:'Change email', de:'E-Mail ändern', es:'Cambiar correo', fr:'Changer l\'e-mail' },
    'set.em.sub': { nl:'Je krijgt een verificatiemail op het nieuwe adres.', en:'You\'ll get a verification email at the new address.', de:'Du erhältst eine Bestätigungs-E-Mail an die neue Adresse.', es:'Recibirás un correo de verificación en la nueva dirección.', fr:'Vous recevrez un e-mail de vérification à la nouvelle adresse.' },
    'set.em.new': { nl:'Nieuw e-mailadres', en:'New email', de:'Neue E-Mail-Adresse', es:'Nuevo correo', fr:'Nouvelle adresse e-mail' },
    'set.em.curPw':{ nl:'Huidig wachtwoord ter bevestiging', en:'Current password to confirm', de:'Aktuelles Passwort zur Bestätigung', es:'Contraseña actual para confirmar', fr:'Mot de passe actuel pour confirmer' },
    'set.em.submit':{ nl:'E-mail wijzigen', en:'Change email', de:'E-Mail ändern', es:'Cambiar correo', fr:'Changer l\'e-mail' },
    'set.em.ok':  { nl:'E-mailadres bijgewerkt — check je inbox', en:'Email updated — check your inbox', de:'E-Mail aktualisiert — prüfe dein Postfach', es:'Correo actualizado — revisa tu bandeja', fr:'E-mail mis à jour — vérifiez votre boîte' },
    'set.em.errCur':{ nl:'Wachtwoord klopt niet.', en:'Password is incorrect.', de:'Passwort ist falsch.', es:'Contraseña incorrecta.', fr:'Mot de passe incorrect.' },
    'set.em.errEmail':{ nl:'Ongeldig e-mailadres.', en:'Invalid email address.', de:'Ungültige E-Mail-Adresse.', es:'Correo no válido.', fr:'Adresse e-mail non valide.' },
    'set.em.errTaken':{ nl:'Dit e-mailadres is al in gebruik.', en:'This email is already in use.', de:'Diese E-Mail wird bereits verwendet.', es:'Este correo ya está en uso.', fr:'Cette adresse est déjà utilisée.' },
    'set.em.errFail':{ nl:'Wijzigen mislukt.', en:'Change failed.', de:'Änderung fehlgeschlagen.', es:'No se pudo cambiar.', fr:'Échec de la modification.' },
    'set.del.h1': { nl:'Account verwijderen', en:'Delete account', de:'Konto löschen', es:'Eliminar cuenta', fr:'Supprimer le compte' },
    'set.del.sub':{ nl:'Alle gegevens worden permanent verwijderd: account, gekoppelde watches, profiel. Match-history per PIN blijft bestaan (gekoppeld aan PIN, niet account).', en:'All data is permanently deleted: account, linked watches, profile. Match history per PIN remains (linked to PIN, not account).', de:'Alle Daten werden dauerhaft gelöscht: Konto, verbundene Uhren, Profil. Match-Verlauf pro PIN bleibt (an PIN gebunden, nicht ans Konto).', es:'Todos los datos se eliminan permanentemente: cuenta, relojes vinculados, perfil. El historial por PIN permanece (vinculado al PIN, no a la cuenta).', fr:'Toutes les données sont supprimées définitivement : compte, montres liées, profil. L\'historique par PIN reste (lié au PIN, pas au compte).' },
    'set.del.confirm':{ nl:'Ja, ik weet het zeker — deze actie kan niet ongedaan worden gemaakt.', en:'Yes, I\'m sure — this action cannot be undone.', de:'Ja, ich bin sicher — diese Aktion kann nicht rückgängig gemacht werden.', es:'Sí, estoy seguro — esta acción no se puede deshacer.', fr:'Oui, je confirme — cette action est irréversible.' },
    'set.del.submit':{ nl:'Verwijder mijn account', en:'Delete my account', de:'Mein Konto löschen', es:'Eliminar mi cuenta', fr:'Supprimer mon compte' },
    'set.del.errCur':{ nl:'Wachtwoord klopt niet.', en:'Password is incorrect.', de:'Passwort ist falsch.', es:'Contraseña incorrecta.', fr:'Mot de passe incorrect.' },
    'set.del.errFail':{ nl:'Verwijderen mislukt.', en:'Delete failed.', de:'Löschen fehlgeschlagen.', es:'No se pudo eliminar.', fr:'Échec de la suppression.' },
    'set.del.modalTitle':{ nl:'Account verwijderen?', en:'Delete account?', de:'Konto löschen?', es:'¿Eliminar cuenta?', fr:'Supprimer le compte ?' },
    'set.del.modalBody':{ nl:'Alle gegevens worden permanent verwijderd. Dit kan <b style="color:var(--them)">niet</b> ongedaan worden gemaakt.', en:'All data is permanently deleted. This <b style="color:var(--them)">cannot</b> be undone.', de:'Alle Daten werden dauerhaft gelöscht. Dies kann <b style="color:var(--them)">nicht</b> rückgängig gemacht werden.', es:'Todos los datos se eliminan permanentemente. Esto <b style="color:var(--them)">no</b> se puede deshacer.', fr:'Toutes les données sont supprimées définitivement. Cette action est <b style="color:var(--them)">irréversible</b>.' },
    'set.del.modalOk':{ nl:'Verwijder definitief', en:'Delete permanently', de:'Endgültig löschen', es:'Eliminar definitivamente', fr:'Supprimer définitivement' },
    'common.cancel':{ nl:'Annuleren', en:'Cancel', de:'Abbrechen', es:'Cancelar', fr:'Annuler' },

    // --- Dashboard ---
    'dash.account':{ nl:'Account', en:'Account', de:'Konto', es:'Cuenta', fr:'Compte' },
    'dash.statusLabel':{ nl:'Status', en:'Status', de:'Status', es:'Estado', fr:'Statut' },
    'dash.quick':{ nl:'Snel overzicht', en:'Quick overview', de:'Schnellüberblick', es:'Resumen rápido', fr:'Aperçu rapide' },
    'dash.watches':{ nl:'Watches', en:'Watches', de:'Uhren', es:'Relojes', fr:'Montres' },
    'dash.coupleBtn':{ nl:'Koppel', en:'Link', de:'Verbinden', es:'Vincular', fr:'Lier' },
    'dash.pinInfo':{ nl:'PIN en Code staan bovenaan het Setup-menu van je RallyPoint-app. Open de app eerst — anders kan de server de code niet verifiëren.', en:'PIN and Code are at the top of your RallyPoint app\'s Setup menu. Open the app first — otherwise the server can\'t verify the code.', de:'PIN und Code stehen oben im Setup-Menü deiner RallyPoint-App. Öffne zuerst die App — sonst kann der Server den Code nicht prüfen.', es:'El PIN y el Código están en la parte superior del menú Configuración de tu app RallyPoint. Abre la app primero — si no, el servidor no puede verificar el código.', fr:'Le PIN et le Code se trouvent en haut du menu Réglages de votre app RallyPoint. Ouvrez d\'abord l\'app — sinon le serveur ne peut pas vérifier le code.' },
    'dash.session':{ nl:'Sessie', en:'Session', de:'Sitzung', es:'Sesión', fr:'Session' },
    'dash.logout':{ nl:'Uitloggen', en:'Log out', de:'Abmelden', es:'Cerrar sesión', fr:'Se déconnecter' },
    'dash.verified':{ nl:'Geverifieerd', en:'Verified', de:'Verifiziert', es:'Verificado', fr:'Vérifié' },
    'dash.unverified':{ nl:'Niet geverifieerd', en:'Not verified', de:'Nicht verifiziert', es:'No verificado', fr:'Non vérifié' },
    'dash.loadFail':{ nl:'Kon account niet laden.', en:'Could not load account.', de:'Konto konnte nicht geladen werden.', es:'No se pudo cargar la cuenta.', fr:'Impossible de charger le compte.' },
    'dash.statMatches':{ nl:'Matches', en:'Matches', de:'Matches', es:'Partidos', fr:'Matchs' },
    'dash.statWinRate':{ nl:'Win-rate', en:'Win rate', de:'Siegrate', es:'Victorias', fr:'Taux de victoire' },
    'dash.statPlaytime':{ nl:'Speeltijd', en:'Play time', de:'Spielzeit', es:'Tiempo de juego', fr:'Temps de jeu' },
    'dash.noWatches':{ nl:'Nog geen watches gekoppeld', en:'No watches linked yet', de:'Noch keine Uhren verbunden', es:'Aún no hay relojes vinculados', fr:'Aucune montre liée' },
    'dash.noWatchesHint':{ nl:'Open RallyPoint op je watch, kopieer <b style="color:var(--muted-hi)">PIN</b> en <b style="color:var(--muted-hi)">Code</b> uit het Setup-menu, en vul hieronder in.', en:'Open RallyPoint on your watch, copy <b style="color:var(--muted-hi)">PIN</b> and <b style="color:var(--muted-hi)">Code</b> from the Setup menu, and enter them below.', de:'Öffne RallyPoint auf deiner Uhr, kopiere <b style="color:var(--muted-hi)">PIN</b> und <b style="color:var(--muted-hi)">Code</b> aus dem Setup-Menü und gib sie unten ein.', es:'Abre RallyPoint en tu reloj, copia el <b style="color:var(--muted-hi)">PIN</b> y el <b style="color:var(--muted-hi)">Código</b> del menú Configuración e introdúcelos abajo.', fr:'Ouvrez RallyPoint sur votre montre, copiez le <b style="color:var(--muted-hi)">PIN</b> et le <b style="color:var(--muted-hi)">Code</b> du menu Réglages et saisissez-les ci-dessous.' },
    'dash.unpair':{ nl:'Ontkoppel', en:'Unlink', de:'Trennen', es:'Desvincular', fr:'Délier' },
    'dash.pinDigits':{ nl:'PIN moet 4 cijfers zijn.', en:'PIN must be 4 digits.', de:'PIN muss 4 Ziffern haben.', es:'El PIN debe tener 4 dígitos.', fr:'Le PIN doit comporter 4 chiffres.' },
    'dash.codeChars':{ nl:'Code moet 6 tekens zijn (0-9, a-f).', en:'Code must be 6 characters (0-9, a-f).', de:'Code muss 6 Zeichen haben (0-9, a-f).', es:'El código debe tener 6 caracteres (0-9, a-f).', fr:'Le code doit comporter 6 caractères (0-9, a-f).' },
    'dash.errTaken':{ nl:'Deze PIN is al gekoppeld aan een ander account.', en:'This PIN is already linked to another account.', de:'Diese PIN ist bereits mit einem anderen Konto verbunden.', es:'Este PIN ya está vinculado a otra cuenta.', fr:'Ce PIN est déjà lié à un autre compte.' },
    'dash.errCode':{ nl:'Code klopt niet — check het Setup-menu op je watch.', en:'Code is incorrect — check the Setup menu on your watch.', de:'Code ist falsch — prüfe das Setup-Menü auf deiner Uhr.', es:'El código no es correcto — revisa el menú Configuración de tu reloj.', fr:'Code incorrect — vérifiez le menu Réglages de votre montre.' },
    'dash.errNotActive':{ nl:'Open je RallyPoint-app op de watch en probeer opnieuw.', en:'Open your RallyPoint app on the watch and try again.', de:'Öffne die RallyPoint-App auf der Uhr und versuche es erneut.', es:'Abre tu app RallyPoint en el reloj e inténtalo de nuevo.', fr:'Ouvrez votre app RallyPoint sur la montre et réessayez.' },
    'dash.errCoupleFail':{ nl:'Koppelen mislukt.', en:'Linking failed.', de:'Verbinden fehlgeschlagen.', es:'No se pudo vincular.', fr:'Échec de la liaison.' },
    'dash.coupled':{ nl:'Watch gekoppeld', en:'Watch linked', de:'Uhr verbunden', es:'Reloj vinculado', fr:'Montre liée' },
    'dash.unpaired':{ nl:'PIN ontkoppeld', en:'PIN unlinked', de:'PIN getrennt', es:'PIN desvinculado', fr:'PIN délié' },
    'dash.unpairTitle':{ nl:'PIN ontkoppelen?', en:'Unlink PIN?', de:'PIN trennen?', es:'¿Desvincular PIN?', fr:'Délier le PIN ?' },
    'dash.unpairBody':{ nl:'PIN <b style="color:var(--ink)">{pin}</b> wordt ontkoppeld van je account. Je kunt \'m later weer koppelen.', en:'PIN <b style="color:var(--ink)">{pin}</b> will be unlinked from your account. You can link it again later.', de:'PIN <b style="color:var(--ink)">{pin}</b> wird von deinem Konto getrennt. Du kannst sie später wieder verbinden.', es:'El PIN <b style="color:var(--ink)">{pin}</b> se desvinculará de tu cuenta. Puedes vincularlo de nuevo más tarde.', fr:'Le PIN <b style="color:var(--ink)">{pin}</b> sera délié de votre compte. Vous pourrez le relier plus tard.' },
    'dash.verifiedOk':{ nl:'E-mail bevestigd. Welkom!', en:'Email confirmed. Welcome!', de:'E-Mail bestätigt. Willkommen!', es:'Correo confirmado. ¡Bienvenido!', fr:'E-mail confirmé. Bienvenue !' },
    'dash.verifiedBad':{ nl:'Bevestiglink ongeldig of verlopen.', en:'Confirmation link invalid or expired.', de:'Bestätigungslink ungültig oder abgelaufen.', es:'Enlace de confirmación no válido o caducado.', fr:'Lien de confirmation non valide ou expiré.' },

    // --- Profile ---
    'prof.theme':{ nl:'Thema', en:'Theme', de:'Thema', es:'Tema', fr:'Thème' },
    'prof.bg':{ nl:'Achtergrond', en:'Background', de:'Hintergrund', es:'Fondo', fr:'Arrière-plan' },
    'prof.bgCustom':{ nl:'Eigen kleur', en:'Custom color', de:'Eigene Farbe', es:'Color propio', fr:'Couleur perso' },
    'prof.personal':{ nl:'Persoonlijke gegevens', en:'Personal details', de:'Persönliche Daten', es:'Datos personales', fr:'Informations personnelles' },
    'prof.displayName':{ nl:'Weergavenaam', en:'Display name', de:'Anzeigename', es:'Nombre visible', fr:'Nom affiché' },
    'prof.displayNamePh':{ nl:'Hoe wil je heten?', en:'What should we call you?', de:'Wie möchtest du heißen?', es:'¿Cómo te llamamos?', fr:'Comment vous appeler ?' },
    'prof.avatar':{ nl:'Avatar URL (optioneel)', en:'Avatar URL (optional)', de:'Avatar-URL (optional)', es:'URL del avatar (opcional)', fr:'URL de l\'avatar (facultatif)' },
    'prof.favSport':{ nl:'Favoriete sport', en:'Favorite sport', de:'Lieblingssport', es:'Deporte favorito', fr:'Sport favori' },
    'prof.publicTitle':{ nl:'Openbare matches', en:'Public matches', de:'Öffentliche Matches', es:'Partidos públicos', fr:'Matchs publics' },
    'prof.publicSub':{ nl:'Toon je lopende matches op de Live Spectator lijst. Anderen zien je naam + score, geen PIN of geschiedenis.', en:'Show your ongoing matches on the Live Spectator list. Others see your name + score, no PIN or history.', de:'Zeige deine laufenden Matches in der Live-Spectator-Liste. Andere sehen deinen Namen + Punktestand, keine PIN oder Verlauf.', es:'Muestra tus partidos en curso en la lista Live Spectator. Otros ven tu nombre + marcador, sin PIN ni historial.', fr:'Affichez vos matchs en cours dans la liste Live Spectator. Les autres voient votre nom + score, sans PIN ni historique.' },
    'prof.save':{ nl:'Opslaan', en:'Save', de:'Speichern', es:'Guardar', fr:'Enregistrer' },
    'prof.saved':{ nl:'Opgeslagen.', en:'Saved.', de:'Gespeichert.', es:'Guardado.', fr:'Enregistré.' },
    'prof.myStats':{ nl:'Mijn stats', en:'My stats', de:'Meine Statistiken', es:'Mis estadísticas', fr:'Mes statistiques' },
    'prof.loadFail':{ nl:'Profiel kon niet geladen worden.', en:'Could not load profile.', de:'Profil konnte nicht geladen werden.', es:'No se pudo cargar el perfil.', fr:'Impossible de charger le profil.' },
    'prof.tMatches':{ nl:'Matches', en:'Matches', de:'Matches', es:'Partidos', fr:'Matchs' },
    'prof.tWinRate':{ nl:'Win-rate', en:'Win rate', de:'Siegrate', es:'Victorias', fr:'Taux de victoire' },
    'prof.tPlaytime':{ nl:'Speeltijd', en:'Play time', de:'Spielzeit', es:'Tiempo de juego', fr:'Temps de jeu' },
    'prof.tPoints':{ nl:'Punten totaal', en:'Total points', de:'Punkte gesamt', es:'Puntos totales', fr:'Points au total' },
    'prof.tLongest':{ nl:'Langste match', en:'Longest match', de:'Längstes Match', es:'Partido más largo', fr:'Match le plus long' },
    'prof.tFav':{ nl:'Favoriet', en:'Favorite', de:'Favorit', es:'Favorito', fr:'Favori' },
    'prof.tWatches':{ nl:'Watches', en:'Watches', de:'Uhren', es:'Relojes', fr:'Montres' },
    'prof.errAvatar':{ nl:'Avatar URL moet beginnen met http(s)://', en:'Avatar URL must start with http(s)://', de:'Avatar-URL muss mit http(s):// beginnen', es:'La URL del avatar debe empezar con http(s)://', fr:'L\'URL de l\'avatar doit commencer par http(s)://' },
    'prof.errSport':{ nl:'Ongeldige sport-keuze.', en:'Invalid sport choice.', de:'Ungültige Sportauswahl.', es:'Deporte no válido.', fr:'Choix de sport non valide.' },
    'prof.errSave':{ nl:'Opslaan mislukt.', en:'Save failed.', de:'Speichern fehlgeschlagen.', es:'Error al guardar.', fr:'Échec de l\'enregistrement.' },
    'prof.savedToast':{ nl:'Profiel opgeslagen', en:'Profile saved', de:'Profil gespeichert', es:'Perfil guardado', fr:'Profil enregistré' },

    // --- Onboarding ---
    'onb.welcome':{ nl:'Welkom bij', en:'Welcome to', de:'Willkommen bei', es:'Bienvenido a', fr:'Bienvenue sur' },
    'onb.intro':{ nl:'Twee snelle stappen om je account klaar te zetten.', en:'Two quick steps to set up your account.', de:'Zwei schnelle Schritte, um dein Konto einzurichten.', es:'Dos pasos rápidos para configurar tu cuenta.', fr:'Deux étapes rapides pour configurer votre compte.' },
    'onb.start':{ nl:'Aan de slag', en:'Get started', de:'Loslegen', es:'Empezar', fr:'Commencer' },
    'onb.skipAll':{ nl:'Overslaan, ga naar dashboard', en:'Skip, go to dashboard', de:'Überspringen, zum Dashboard', es:'Omitir, ir al panel', fr:'Passer, aller au tableau de bord' },
    'onb.step1num':{ nl:'Stap 1 van 2', en:'Step 1 of 2', de:'Schritt 1 von 2', es:'Paso 1 de 2', fr:'Étape 1 sur 2' },
    'onb.step2num':{ nl:'Stap 2 van 2', en:'Step 2 of 2', de:'Schritt 2 von 2', es:'Paso 2 de 2', fr:'Étape 2 sur 2' },
    'onb.s1.h1':{ nl:'Je profiel', en:'Your profile', de:'Dein Profil', es:'Tu perfil', fr:'Votre profil' },
    'onb.s1.sub':{ nl:'Persoonlijke info — kun je later wijzigen.', en:'Personal info — you can change it later.', de:'Persönliche Infos — später änderbar.', es:'Información personal — puedes cambiarla luego.', fr:'Infos personnelles — modifiables plus tard.' },
    'onb.s1.name':{ nl:'Hoe heet je?', en:'What\'s your name?', de:'Wie heißt du?', es:'¿Cómo te llamas?', fr:'Comment vous appelez-vous ?' },
    'onb.skip':{ nl:'Overslaan', en:'Skip', de:'Überspringen', es:'Omitir', fr:'Passer' },
    'onb.next':{ nl:'Volgende', en:'Next', de:'Weiter', es:'Siguiente', fr:'Suivant' },
    'onb.s2.h1':{ nl:'Koppel je watch', en:'Link your watch', de:'Verbinde deine Uhr', es:'Vincula tu reloj', fr:'Liez votre montre' },
    'onb.s2.sub':{ nl:'Open de RallyPoint-app op je horloge en kopieer <b style="color:var(--ink)">PIN</b> en <b style="color:var(--ink)">Code</b> uit het Setup-menu.', en:'Open the RallyPoint app on your watch and copy the <b style="color:var(--ink)">PIN</b> and <b style="color:var(--ink)">Code</b> from the Setup menu.', de:'Öffne die RallyPoint-App auf deiner Uhr und kopiere <b style="color:var(--ink)">PIN</b> und <b style="color:var(--ink)">Code</b> aus dem Setup-Menü.', es:'Abre la app RallyPoint en tu reloj y copia el <b style="color:var(--ink)">PIN</b> y el <b style="color:var(--ink)">Código</b> del menú Configuración.', fr:'Ouvrez l\'app RallyPoint sur votre montre et copiez le <b style="color:var(--ink)">PIN</b> et le <b style="color:var(--ink)">Code</b> du menu Réglages.' },
    'onb.s2.pin':{ nl:'PIN (4 cijfers)', en:'PIN (4 digits)', de:'PIN (4 Ziffern)', es:'PIN (4 dígitos)', fr:'PIN (4 chiffres)' },
    'onb.s2.code':{ nl:'Code (6 tekens)', en:'Code (6 characters)', de:'Code (6 Zeichen)', es:'Código (6 caracteres)', fr:'Code (6 caractères)' },
    'onb.s2.skip':{ nl:'Sla over', en:'Skip', de:'Überspringen', es:'Omitir', fr:'Passer' },
    'onb.s2.link':{ nl:'Koppelen', en:'Link', de:'Verbinden', es:'Vincular', fr:'Lier' }
  };

  function resolveLang() {
    var ls = (window.localStorage && localStorage.getItem('rallypointLang')) || '';
    if (LANGS.indexOf(ls) >= 0) return ls;
    var htmlLang = document.documentElement.getAttribute('lang') || '';
    if (LANGS.indexOf(htmlLang) >= 0) return htmlLang;
    var nav = (navigator.language || 'nl').slice(0, 2);
    if (LANGS.indexOf(nav) >= 0) return nav;
    return 'nl';
  }

  var cur = resolveLang();

  function t(key, vars) {
    var row = S[key];
    var s = row ? (row[cur] || row.en || row.nl) : key;
    if (vars) { for (var k in vars) { s = s.split('{' + k + '}').join(vars[k]); } }
    return s;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    root.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    document.documentElement.setAttribute('lang', cur);
  }

  // setLang: pas toe + (optioneel) sla op. silent=true betekent: alleen syncen
  // met de server-waarde, niet terugschrijven (voorkomt loops).
  function setLang(lang, silent) {
    if (LANGS.indexOf(lang) < 0) return;
    cur = lang;
    if (!silent && window.localStorage) { localStorage.setItem('rallypointLang', lang); }
    apply();
    if (!silent && window.__rpOnLangChange) { try { window.__rpOnLangChange(lang); } catch (e) {} }
  }

  window.RP = {
    get lang() { return cur; },
    langs: LANGS,
    langNames: LANG_NAMES,
    t: t,
    apply: apply,
    setLang: setLang
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); });
  } else {
    apply();
  }
})();
