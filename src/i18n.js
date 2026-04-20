const STORAGE_KEY = 'sporely-locale'
const FALLBACK_LOCALE = 'en'
const SUPPORTED_LOCALES = ['en', 'nb_NO', 'sv_SE', 'de_DE']

const messages = {
  en: {
    'app.name': 'Sporely',
    'auth.tagline': 'Field observations, everywhere.',
    'auth.signIn': 'Sign in',
    'auth.createAccount': 'Create account',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.passwordMin': 'At least 6 characters',
    'auth.noAccount': 'No account?',
    'auth.createOne': 'Create one',
    'auth.alreadyHaveOne': 'Already have one?',
    'auth.checkInbox': 'Check your inbox to confirm your account.',
    'auth.resendEmail': 'Resend email',
    'auth.emailAlreadyConfirmed': 'Your email is already confirmed. Try signing in.',
    'auth.couldNotResend': 'Could not resend: {message}',
    'auth.confirmationSent': 'Confirmation email sent. Check your inbox.',
    'auth.confirmationExpired': 'Your confirmation link has expired. Enter your email below and request a new one.',
    'auth.accessDenied': 'Access denied. Please try again.',
    'auth.genericError': 'Something went wrong. Please try again.',
    'auth.localCaptchaHint': 'Local dev is hiding Turnstile, but Supabase still requires CAPTCHA on the server. For phone testing, use your deployed URL or temporarily disable CAPTCHA in Supabase Auth.',
    'auth.existingAccount': 'An account with that email already exists. Sign in, or use "Forgot password" to reset it.',
    'common.sync': 'Sync',
    'common.pleaseWait': 'Please wait…',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.clear': 'Clear',
    'common.loading': 'Loading…',
    'common.unknown': 'Unknown',
    'common.you': 'You',
    'common.errorPrefix': 'Error: {message}',
    'common.artsorakelError': 'Artsorakel: {message}',
    'common.close': 'Close',
    'home.sporelyCam': 'Sporely Cam',
    'home.importPhotos': 'Import Photos',
    'home.recentFinds': 'Recent Finds',
    'home.history': 'History →',
    'home.recentComments': 'Recent Comments',
    'home.noObservations': 'No observations yet.',
    'home.noComments': 'No comments yet.',
    'home.unidentified': 'Unidentified',
    'stats.finds': 'Finds',
    'stats.species': 'Species',
    'stats.friendsActive': 'Friends active',
    'stats.friends': 'Friends',
    'importSheet.title': 'Import photos',
    'importSheet.subtitle': 'Choose the fastest path, or browse files when you want the best shot at keeping original metadata.',
    'importSheet.photosAndVideos': 'Photos & videos',
    'importSheet.quickPicker': 'Quick picker from your gallery.',
    'importSheet.browseFiles': 'Browse files',
    'importSheet.heicHint': 'Best for original HEIC metadata on some Android phones.',
    'capture.acquiring': 'Acquiring…',
    'capture.batchActive': 'Batch Active',
    'capture.done': 'DONE',
    'capture.cameraAccessNeeded': 'Camera access needed',
    'capture.tryAgain': 'Try again',
    'capture.cameraPermissionAndroid': 'Allow Camera for Sporely in Android app permissions, then tap "Try again".',
    'capture.cameraPermissionIphone': 'On iPhone: open Settings, scroll to Safari (or your browser), then allow Camera access.',
    'capture.cameraPermissionFirefox': 'In Firefox: tap the lock icon in the address bar, then allow Camera access.',
    'capture.cameraPermissionSamsung': 'In Samsung Internet: tap the lock icon in the address bar, then allow Camera access.',
    'capture.cameraPermissionBrowser': 'Tap the lock or camera icon in your browser address bar, allow camera access, then tap "Try again".',
    'capture.capturePhoto': 'Capture photo',
    'capture.noCameraFound': 'No camera was found on this device.',
    'capture.cameraStartFailed': 'Camera could not be started ({name}). Close other apps using the camera and try again.',
    'capture.photoCaptured': 'Photo {count} captured',
    'capture.lightReading': 'LIGHT: {lux} LUX / F-STOP: {fStop}',
    'review.review': 'Review',
    'review.addPhoto': 'Add photo',
    'review.fieldMetadata': 'Field Metadata',
    'review.location': 'Location',
    'review.latLon': 'Lat/Lon',
    'review.currentLocation': 'Current location',
    'review.gpsAccuracy': 'GPS Accuracy',
    'review.altitude': 'Altitude',
    'review.sharing': 'Sharing',
    'review.habitat': 'Habitat',
    'review.notes': 'Notes',
    'review.fieldNotes': 'Field notes…',
    'review.idNeeded': 'Uncertain ID',
    'review.createsOne': 'Creates one observation in Sporely Cloud',
    'review.createsMany': 'Creates observations in Sporely Cloud',
    'review.noCaptures': 'No captures yet',
    'review.capturedRange': 'Captured {start} — {end}',
    'review.identifying': 'Identifying…',
    'review.noMatch': 'Artsorakel returned no suggestion',
    'review.aiUnavailable': 'Artsorakel unavailable right now.',
    'review.noPhotosToIdentify': 'No photos to identify',
    'review.runningAi': 'Running Artsorakel on {count}…',
    'review.notSignedIn': 'Not signed in',
    'review.noPhotosToSync': 'No photos to sync',
    'review.syncing': 'Adding to sync queue…',
    'review.synced': 'Queued 1 observation with {count} ✓',
    'review.syncFailed': 'Could not queue observation: {message}',
    'review.uploadedComplete': 'Uploaded observation with {count} photo(s) ✓',
    'detail.backHome': 'Home',
    'detail.backFinds': 'Finds',
    'detail.backMap': 'Map',
    'detail.backGeneric': 'Back',
    'detail.unknownSpecies': 'Unknown species',
    'detail.species': 'Species',
    'detail.identifyAI': 'Identify with Artsorakel AI',
    'detail.location': 'Location',
    'detail.currentLocation': 'Current location',
    'detail.habitat': 'Habitat',
    'detail.notes': 'Notes',
    'detail.idNeeded': 'Uncertain ID',
    'detail.sharing': 'Sharing',
    'detail.onlyOwnerOverwriteLocation': 'Only the owner can overwrite the location',
    'detail.currentGpsUnavailable': 'Current GPS unavailable',
    'detail.overwriteLocationConfirm': 'Current location will overwrite the existing location. Continue?',
    'detail.locationSet': 'Location set from current GPS',
    'detail.noPhotoToIdentify': 'No photo to identify',
    'detail.couldNotLoadObservation': 'Could not load observation',
    'detail.onlyOwnerEdit': 'Only the owner can edit this observation',
    'detail.saveFailed': 'Save failed: {message}',
    'detail.saved': 'Saved ✓',
    'detail.deleteFailed': 'Delete failed: {message}',
    'detail.onlyOwnerDelete': 'Only the owner can delete this observation',
    'detail.confirmDeleteImage': 'Delete this image? This cannot be undone.',
    'detail.deleteConfirm': 'Delete this observation? This cannot be undone.',
    'detail.deleted': 'Observation deleted',
    'detail.blockUser': 'Block user',
    'detail.reportPost': 'Report post',
    'detail.blockUserConfirm': 'Block this user? You will no longer see their posts and comments.',
    'detail.blockFailed': 'Failed to block user: ',
    'detail.userBlocked': 'User blocked.',
    'detail.reportReason': 'Why are you reporting this post? (e.g. spam, inappropriate)',
    'detail.reportFailed': 'Failed to report: ',
    'detail.postReported': 'Post reported to admins.',
    'comments.title': 'Comments',
    'comments.add': 'Add a comment…',
    'comments.send': 'Send',
    'comments.couldNotLoad': 'Could not load comments.',
    'comments.none': 'No comments yet.',
    'comments.postFailed': 'Could not post comment: {message}',
    'comments.posted': 'Comment posted ✓',
    'comments.reportReason': 'Why are you reporting this comment?',
    'comments.reportFailed': 'Failed to report: ',
    'comments.commentReported': 'Comment reported.',
    'comments.blockConfirm': 'Block this user?',
    'comments.blockFailed': 'Failed to block: ',
    'comments.userBlocked': 'User blocked.',
    'finds.search': 'Search species, location, notes…',
    'finds.searchAria': 'Search',
    'finds.clearSearch': 'Clear search',
    'finds.documentedObservations': 'Documented observations.',
    'finds.singleColumn': 'Single column view',
    'finds.twoColumns': 'Two columns',
    'finds.threeColumns': 'Three columns',
    'finds.uncertainIds': 'Uncertain IDs',
    'finds.tinyGrid': 'Tiny grid view',
    'finds.newObservationAria': 'New observation',
    'finds.couldNotLoad': 'Could not load finds',
    'finds.noFriends': 'No friends\' finds yet.',
    'finds.noObservations': 'No observations yet.',
    'finds.noObservationsCapture': 'No observations yet — go capture some!',
    'finds.noResults': 'No results for "{query}".',
    'finds.pendingUpload': 'Queued for upload',
    'finds.pendingUploading': 'Uploading photo {current} of {total}…',
    'finds.pendingFinalizing': 'Finalizing upload…',
    'finds.pendingRetrying': 'Retrying upload…',
    'finds.pullToRefresh': 'Pull to refresh',
    'finds.releaseToRefresh': 'Release to refresh',
    'finds.refreshing': 'Refreshing…',
    'finds.unidentified': 'Unidentified',
    'finds.observationCount.one': '{count} observation.',
    'finds.observationCount.other': '{count} observations.',
    'finds.speciesCount.one': '{count} species',
    'finds.speciesCount.other': '{count} species',
    'map.filter': 'Filter map…',
    'map.clear': 'Clear',
    'map.viewDetails': 'View details →',
    'scope.mine': 'Mine',
    'scope.friends': 'Friends',
    'scope.community': 'Public',
    'scope.all': 'All',
    'profile.title': 'Profile',
    'profile.fullNameOptional': 'Full name (optional)',
    'profile.saveProfile': 'Save profile',
    'profile.addFriend': 'Add Friend',
    'profile.friendSearch': 'Email, name or @username…',
    'profile.search': 'Search',
    'profile.pendingRequests': 'Pending Requests',
    'profile.friends': 'Friends',
    'profile.noFriends': 'No friends yet.',
    'profile.signOut': 'Sign out',
    'profile.deleteAccount': 'Delete account',
    'profile.changePhoto': 'Change photo',
    'profile.usernameTaken': 'Username already taken',
    'profile.saved': 'Profile saved ✓',
    'profile.uploadFailed': 'Upload failed: {message}',
    'profile.photoUpdated': 'Photo updated ✓',
    'profile.searching': 'Searching…',
    'profile.noUsersFound': 'No users found.',
    'profile.requestAlreadySent': 'Request already sent',
    'profile.requestSent': 'Friend request sent ✓',
    'profile.friendAccepted': 'Friend accepted ✓',
    'profile.friendRemoved': 'Friend removed',
    'profile.deleteConfirm': 'Delete {email} permanently?\n\nThis removes your profile, observations, comments, friendships, and uploaded images. This cannot be undone.',
    'profile.deleting': 'Deleting…',
    'profile.deleteFunctionMissing': 'Delete account function is not deployed yet',
    'profile.deleteFailed': 'Could not delete account: {message}',
    'profile.accountDeleted': 'Account deleted',
    'profile.accept': 'Accept',
    'profile.decline': 'Decline',
    'profile.remove': 'Remove',
    'profile.sent': 'Sent',
    'profile.add': 'Add',
    'profile.cloudPlan': 'Account status',
    'profile.cloudStorage': 'Account',
    'profile.uploads': 'Image resolution',
    'profile.storage': 'Sync history',
    'profile.storageUsage': 'Storage',
    'profile.imageCount': 'Images',
    'profile.imageResolutionFree': '2MP',
    'profile.imageResolutionPro': '12MP',
    'profile.imageCountValue.one': '{count} image',
    'profile.imageCountValue.other': '{count} images',
    'profile.syncNever': 'No syncs from this device yet',
    'profile.syncTodayAt': 'Today at {time}',
    'profile.syncAt': '{date} at {time}',
    'profile.storageUnknown': 'Not tracked yet',
    'profile.storageUsedOnly': '{used} used',
    'profile.storageUsedOfQuota': '{used} / {total}',
    'profile.termsOfService': 'Terms of Service',
    'avatar.cropPhoto': 'Crop Photo',
    'avatar.hint': 'Pinch to zoom · Drag to reposition',
    'avatar.usePhoto': 'Use Photo',
    'nav.home': 'Home',
    'nav.finds': 'Finds',
    'nav.map': 'Map',
    'nav.profile': 'Profile',
    'settings.title': 'Settings',
    'settings.appearance': 'Appearance',
    'settings.auto': 'Auto',
    'settings.light': 'Light',
    'settings.dark': 'Dark',
    'settings.language': 'Language',
    'settings.appLanguage': 'App language',
    'settings.photoImport': 'Photo Import',
    'settings.newObservationAfter': 'New observation after',
    'settings.min': 'min',
    'settings.photoGapHint': 'Photo import from your device will group images based on time between photos.',
    'settings.imageResolution': 'Image resolution',
    'settings.imageResolutionReduced': 'Reduced (2MP)',
    'settings.imageResolutionMax': 'Max (12MP)',
    'settings.sync': 'Sync',
    'settings.syncOverMobileData': 'Sync over mobile data',
    'settings.defaultVisibility': 'Default visibility',
    'settings.data': 'Data',
    'settings.clearLocalCache': 'Clear local cache',
    'settings.clearLocalCacheHint': 'Clears temporary import photos and browser media cache. Queued observations stay safe.',
    'settings.clearLocalCacheConfirm': 'Clear temporary import photos and browser media cache? Queued observations will stay safe.',
    'settings.localCacheCleared': 'Local cache cleared',
    'settings.localCacheFailed': 'Could not clear cache: {message}',
    'import.processing': 'Processing…',
    'import.readingFiles': 'Reading files…',
    'import.importingFile': 'Importing {current} of {total}…',
    'import.readingTimestamps': 'Reading timestamps…',
    'import.convertingFile': 'Converting {current} of {total}…',
    'import.failed': 'Import failed',
    'import.saveAll': 'Queue All',
    'import.currentGpsUnavailable': 'Current GPS unavailable',
    'import.overwriteExifConfirm': 'Current location will overwrite the EXIF location. Continue?',
    'import.noHeicGps': 'No photo GPS found in this HEIC. On some iPhone web uploads, location metadata is not exposed to the browser.',
    'import.setFromGps': 'Set from GPS',
    'import.identifying': 'Identifying…',
    'import.failedOneGroup': 'Failed to queue one group. Others may have queued.',
    'import.saved': 'Queued {count} for upload',
    'import.queuedSingle': 'Added to sync queue',
    'counts.photo.one': '{count} photo',
    'counts.photo.other': '{count} photos',
    'counts.observation.one': '{count} observation',
    'counts.observation.other': '{count} observations',
    'counts.group.one': '{count} group',
    'counts.group.other': '{count} groups',
    'photo.close': 'Close',
    'photo.previous': 'Previous',
    'photo.next': 'Next',
    'crop.editorTitle': 'AI crop',
    'crop.noCropHint': 'Tap a photo to set AI crop',
    'crop.statusSome': '{cropped}/{total} AI crop',
    'visibility.private': 'Private',
    'visibility.friends': 'Friends',
    'visibility.public': 'Public',
  },
  nb_NO: {
    'app.name': 'Sporely',
    'auth.tagline': 'Feltobservasjoner, overalt.',
    'auth.signIn': 'Logg inn',
    'auth.createAccount': 'Opprett konto',
    'auth.email': 'E-post',
    'auth.password': 'Passord',
    'auth.passwordMin': 'Minst 6 tegn',
    'auth.noAccount': 'Ingen konto?',
    'auth.createOne': 'Opprett en',
    'auth.alreadyHaveOne': 'Har du allerede en?',
    'auth.checkInbox': 'Sjekk innboksen for å bekrefte kontoen din.',
    'auth.resendEmail': 'Send e-post på nytt',
    'auth.emailAlreadyConfirmed': 'E-posten din er allerede bekreftet. Prøv å logge inn.',
    'auth.couldNotResend': 'Kunne ikke sende på nytt: {message}',
    'auth.confirmationSent': 'Bekreftelsesmelding sendt. Sjekk innboksen.',
    'auth.confirmationExpired': 'Bekreftelseslenken er utløpt. Skriv inn e-posten din under og be om en ny.',
    'auth.accessDenied': 'Tilgang nektet. Prøv igjen.',
    'auth.genericError': 'Noe gikk galt. Prøv igjen.',
    'auth.localCaptchaHint': 'Lokal utvikling skjuler Turnstile, men Supabase krever fortsatt CAPTCHA på serveren. For testing på telefon kan du bruke den deployede URL-en eller midlertidig slå av CAPTCHA i Supabase Auth.',
    'auth.existingAccount': 'Det finnes allerede en konto med den e-posten. Logg inn, eller bruk "Glemt passord" for å tilbakestille den.',
    'common.sync': 'Synk',
    'common.pleaseWait': 'Vent litt…',
    'common.cancel': 'Avbryt',
    'common.save': 'Lagre',
    'common.delete': 'Slett',
    'common.clear': 'Tøm',
    'common.loading': 'Laster…',
    'common.unknown': 'Ukjent',
    'common.you': 'Du',
    'common.errorPrefix': 'Feil: {message}',
    'common.artsorakelError': 'Artsorakel: {message}',
    'common.close': 'Lukk',
    'home.sporelyCam': 'Sporely Cam',
    'home.importPhotos': 'Importer bilder',
    'home.recentFinds': 'Siste funn',
    'home.history': 'Historikk →',
    'home.recentComments': 'Siste kommentarer',
    'home.noObservations': 'Ingen observasjoner ennå.',
    'home.noComments': 'Ingen kommentarer ennå.',
    'home.unidentified': 'Ubestemt',
    'stats.finds': 'Funn',
    'stats.species': 'Arter',
    'stats.friendsActive': 'Aktive venner',
    'stats.friends': 'Venner',
    'importSheet.title': 'Importer bilder',
    'importSheet.subtitle': 'Velg den raskeste veien, eller bla gjennom filer når du vil ha størst sjanse for å beholde original metadata.',
    'importSheet.photosAndVideos': 'Bilder og videoer',
    'importSheet.quickPicker': 'Rask velger fra bildegalleriet.',
    'importSheet.browseFiles': 'Bla gjennom filer',
    'importSheet.heicHint': 'Best for original HEIC-metadata på noen Android-telefoner.',
    'capture.acquiring': 'Henter posisjon…',
    'capture.batchActive': 'Serie aktiv',
    'capture.done': 'FERDIG',
    'capture.cameraAccessNeeded': 'Kameratilgang kreves',
    'capture.tryAgain': 'Prøv igjen',
    'capture.cameraPermissionAndroid': 'Gi Sporely kameratilgang i Android-apprettigheter, og trykk deretter "Prøv igjen".',
    'capture.cameraPermissionIphone': 'På iPhone: åpne Innstillinger, finn Safari eller nettleseren din, og gi kameratilgang.',
    'capture.cameraPermissionFirefox': 'I Firefox: trykk på hengelåsikonet i adressefeltet og tillat kameratilgang.',
    'capture.cameraPermissionSamsung': 'I Samsung Internet: trykk på hengelåsikonet i adressefeltet og tillat kameratilgang.',
    'capture.cameraPermissionBrowser': 'Trykk på hengelås- eller kameraikonet i adressefeltet, tillat kameratilgang, og trykk deretter "Prøv igjen".',
    'capture.capturePhoto': 'Ta bilde',
    'capture.noCameraFound': 'Fant ikke noe kamera på denne enheten.',
    'capture.cameraStartFailed': 'Kunne ikke starte kameraet ({name}). Lukk andre apper som bruker kameraet og prøv igjen.',
    'capture.photoCaptured': 'Bilde {count} tatt',
    'capture.lightReading': 'LYS: {lux} LUX / F-STOPP: {fStop}',
    'review.review': 'Gjennomgang',
    'review.addPhoto': 'Legg til bilde',
    'review.fieldMetadata': 'Feltmetadata',
    'review.location': 'Sted',
    'review.latLon': 'Bredde/lengde',
    'review.currentLocation': 'Nåværende sted',
    'review.gpsAccuracy': 'GPS-nøyaktighet',
    'review.altitude': 'Høyde',
    'review.sharing': 'Deling',
    'review.habitat': 'Habitat',
    'review.notes': 'Notater',
    'review.fieldNotes': 'Feltnotater…',
    'review.idNeeded': 'Usikker ID',
    'review.createsOne': 'Oppretter én observasjon i Sporely Cloud',
    'review.createsMany': 'Oppretter observasjoner i Sporely Cloud',
    'review.noCaptures': 'Ingen opptak ennå',
    'review.capturedRange': 'Tatt {start} — {end}',
    'review.identifying': 'Identifiserer…',
    'review.noMatch': 'Artsorakel ga ingen forslag',
    'review.aiUnavailable': 'Artsorakel er utilgjengelig akkurat nå.',
    'review.noPhotosToIdentify': 'Ingen bilder å identifisere',
    'review.runningAi': 'Kjører Artsorakel på {count}…',
    'review.notSignedIn': 'Ikke logget inn',
    'review.noPhotosToSync': 'Ingen bilder å synkronisere',
    'review.syncing': 'Legger til i synkøen…',
    'review.synced': 'Satte 1 observasjon med {count} i kø ✓',
    'review.syncFailed': 'Kunne ikke legge observasjonen i kø: {message}',
    'review.uploadedComplete': 'Observasjonen er lastet opp med {count} bilde(r) ✓',
    'detail.backHome': 'Hjem',
    'detail.backFinds': 'Funn',
    'detail.backMap': 'Kart',
    'detail.backGeneric': 'Tilbake',
    'detail.unknownSpecies': 'Ukjent art',
    'detail.species': 'Art',
    'detail.identifyAI': 'Identifiser med Artsorakel AI',
    'detail.location': 'Sted',
    'detail.currentLocation': 'Nåværende sted',
    'detail.habitat': 'Habitat',
    'detail.notes': 'Notater',
    'detail.idNeeded': 'Usikker ID',
    'detail.sharing': 'Deling',
    'detail.onlyOwnerOverwriteLocation': 'Bare eieren kan overskrive stedet',
    'detail.currentGpsUnavailable': 'Nåværende GPS er utilgjengelig',
    'detail.overwriteLocationConfirm': 'Nåværende sted vil overskrive det eksisterende stedet. Fortsette?',
    'detail.locationSet': 'Sted satt fra nåværende GPS',
    'detail.noPhotoToIdentify': 'Ingen bilde å identifisere',
    'detail.couldNotLoadObservation': 'Kunne ikke laste observasjon',
    'detail.onlyOwnerEdit': 'Bare eieren kan redigere denne observasjonen',
    'detail.saveFailed': 'Lagring feilet: {message}',
    'detail.saved': 'Lagret ✓',
    'detail.deleteFailed': 'Sletting feilet: {message}',
    'detail.onlyOwnerDelete': 'Bare eieren kan slette denne observasjonen',
    'detail.confirmDeleteImage': 'Slette dette bildet? Dette kan ikke angres.',
    'detail.deleteConfirm': 'Slette denne observasjonen? Dette kan ikke angres.',
    'detail.deleted': 'Observasjonen ble slettet',
    'detail.blockUser': 'Blokker bruker',
    'detail.reportPost': 'Rapporter innlegg',
    'detail.blockUserConfirm': 'Blokker denne brukeren? Du vil ikke lenger se innleggene og kommentarene deres.',
    'detail.blockFailed': 'Kunne ikke blokkere bruker: ',
    'detail.userBlocked': 'Bruker blokkert.',
    'detail.reportReason': 'Hvorfor rapporterer du dette innlegget? (f.eks. spam, upassende)',
    'detail.reportFailed': 'Kunne ikke rapportere: ',
    'detail.postReported': 'Innlegg rapportert til administratorer.',
    'comments.title': 'Kommentarer',
    'comments.add': 'Legg til en kommentar…',
    'comments.send': 'Send',
    'comments.couldNotLoad': 'Kunne ikke laste kommentarer.',
    'comments.none': 'Ingen kommentarer ennå.',
    'comments.postFailed': 'Kunne ikke poste kommentar: {message}',
    'comments.posted': 'Kommentar lagt ut ✓',
    'comments.reportReason': 'Hvorfor rapporterer du denne kommentaren?',
    'comments.reportFailed': 'Kunne ikke rapportere: ',
    'comments.commentReported': 'Kommentar rapportert.',
    'comments.blockConfirm': 'Blokker denne brukeren?',
    'comments.blockFailed': 'Kunne ikke blokkere: ',
    'comments.userBlocked': 'Bruker blokkert.',
    'finds.search': 'Søk etter art, sted, notater…',
    'finds.searchAria': 'Søk',
    'finds.clearSearch': 'Tøm søk',
    'finds.documentedObservations': 'Dokumenterte observasjoner.',
    'finds.singleColumn': 'Enkeltkolonnevisning',
    'finds.twoColumns': 'To kolonner',
    'finds.threeColumns': 'Tre kolonner',
    'finds.uncertainIds': 'Usikre ID-er',
    'finds.tinyGrid': 'Lite rutenett',
    'finds.newObservationAria': 'Ny observasjon',
    'finds.couldNotLoad': 'Kunne ikke laste funn',
    'finds.noFriends': 'Ingen venners funn ennå.',
    'finds.noObservations': 'Ingen observasjoner ennå.',
    'finds.noObservationsCapture': 'Ingen observasjoner ennå — gå og ta noen!',
    'finds.noResults': 'Ingen treff for "{query}".',
    'finds.pendingUpload': 'Lagt i kø for opplasting',
    'finds.pendingUploading': 'Laster opp bilde {current} av {total}…',
    'finds.pendingFinalizing': 'Fullfører opplasting…',
    'finds.pendingRetrying': 'Prøver opplasting på nytt…',
    'finds.pullToRefresh': 'Dra ned for å oppdatere',
    'finds.releaseToRefresh': 'Slipp for å oppdatere',
    'finds.refreshing': 'Oppdaterer…',
    'finds.unidentified': 'Ubestemt',
    'finds.observationCount.one': '{count} observasjon.',
    'finds.observationCount.other': '{count} observasjoner.',
    'finds.speciesCount.one': '{count} art',
    'finds.speciesCount.other': '{count} arter',
    'map.filter': 'Filtrer kart…',
    'map.clear': 'Tøm',
    'map.viewDetails': 'Vis detaljer →',
    'scope.mine': 'Mine',
    'scope.friends': 'Venner',
    'scope.community': 'Offentlig',
    'scope.all': 'Alle',
    'profile.title': 'Profil',
    'profile.fullNameOptional': 'Fullt navn (valgfritt)',
    'profile.saveProfile': 'Lagre profil',
    'profile.addFriend': 'Legg til venn',
    'profile.friendSearch': 'E-post, navn eller @brukernavn…',
    'profile.search': 'Søk',
    'profile.pendingRequests': 'Ventende forespørsler',
    'profile.friends': 'Venner',
    'profile.noFriends': 'Ingen venner ennå.',
    'profile.signOut': 'Logg ut',
    'profile.deleteAccount': 'Slett konto',
    'profile.changePhoto': 'Bytt bilde',
    'profile.usernameTaken': 'Brukernavnet er opptatt',
    'profile.saved': 'Profil lagret ✓',
    'profile.uploadFailed': 'Opplasting feilet: {message}',
    'profile.photoUpdated': 'Bilde oppdatert ✓',
    'profile.searching': 'Søker…',
    'profile.noUsersFound': 'Fant ingen brukere.',
    'profile.requestAlreadySent': 'Forespørsel er allerede sendt',
    'profile.requestSent': 'Venneforespørsel sendt ✓',
    'profile.friendAccepted': 'Venn godtatt ✓',
    'profile.friendRemoved': 'Venn fjernet',
    'profile.deleteConfirm': 'Slette {email} permanent?\n\nDette fjerner profilen, observasjonene, kommentarene, vennskapene og de opplastede bildene dine. Dette kan ikke angres.',
    'profile.deleting': 'Sletter…',
    'profile.deleteFunctionMissing': 'Funksjonen for kontosletting er ikke deployet ennå',
    'profile.deleteFailed': 'Kunne ikke slette konto: {message}',
    'profile.accountDeleted': 'Konto slettet',
    'profile.accept': 'Godta',
    'profile.decline': 'Avslå',
    'profile.remove': 'Fjern',
    'profile.sent': 'Sendt',
    'profile.add': 'Legg til',
    'profile.cloudPlan': 'Kontostatus',
    'profile.cloudStorage': 'Konto',
    'profile.uploads': 'Bildeoppløsning',
    'profile.storage': 'Synkhistorikk',
    'profile.storageUsage': 'Lagring',
    'profile.imageCount': 'Bilder',
    'profile.imageResolutionFree': '2MP',
    'profile.imageResolutionPro': '12MP',
    'profile.imageCountValue.one': '{count} bilde',
    'profile.imageCountValue.other': '{count} bilder',
    'profile.syncNever': 'Ingen synk fra denne enheten ennå',
    'profile.syncTodayAt': 'I dag kl. {time}',
    'profile.syncAt': '{date} kl. {time}',
    'profile.storageUnknown': 'Ikke sporet ennå',
    'profile.storageUsedOnly': '{used} brukt',
    'profile.storageUsedOfQuota': '{used} / {total}',
    'profile.termsOfService': 'Vilkår for bruk',
    'avatar.cropPhoto': 'Beskjær bilde',
    'avatar.hint': 'Klyp for å zoome · Dra for å flytte',
    'avatar.usePhoto': 'Bruk bilde',
    'nav.home': 'Hjem',
    'nav.finds': 'Funn',
    'nav.map': 'Kart',
    'nav.profile': 'Profil',
    'settings.title': 'Innstillinger',
    'settings.appearance': 'Utseende',
    'settings.auto': 'Auto',
    'settings.light': 'Lys',
    'settings.dark': 'Mørk',
    'settings.language': 'Språk',
    'settings.appLanguage': 'Appspråk',
    'settings.photoImport': 'Bildeimport',
    'settings.newObservationAfter': 'Ny observasjon etter',
    'settings.min': 'min',
    'settings.photoGapHint': 'Bildeimport fra enheten grupperer bilder basert på tiden mellom bildene.',
    'settings.imageResolution': 'Bildeoppløsning',
    'settings.imageResolutionReduced': 'Redusert (2MP)',
    'settings.imageResolutionMax': 'Maks (12MP)',
    'settings.sync': 'Synk',
    'settings.syncOverMobileData': 'Synk over mobildata',
    'settings.defaultVisibility': 'Standard synlighet',
    'settings.data': 'Data',
    'settings.clearLocalCache': 'Tøm lokal cache',
    'settings.clearLocalCacheHint': 'Tømmer midlertidige importbilder og nettleserens mediecache. Observasjoner i kø beholdes.',
    'settings.clearLocalCacheConfirm': 'Tømme midlertidige importbilder og nettleserens mediecache? Observasjoner i kø beholdes.',
    'settings.localCacheCleared': 'Lokal cache tømt',
    'settings.localCacheFailed': 'Kunne ikke tømme cache: {message}',
    'import.processing': 'Behandler…',
    'import.readingFiles': 'Leser filer…',
    'import.importingFile': 'Importerer {current} av {total}…',
    'import.readingTimestamps': 'Leser tidspunkter…',
    'import.convertingFile': 'Konverterer {current} av {total}…',
    'import.failed': 'Import feilet',
    'import.saveAll': 'Legg alle i kø',
    'import.currentGpsUnavailable': 'Nåværende GPS er utilgjengelig',
    'import.overwriteExifConfirm': 'Nåværende sted vil overskrive EXIF-stedet. Fortsette?',
    'import.noHeicGps': 'Fant ingen GPS-data i dette HEIC-bildet. På noen iPhone-opplastinger på web eksponeres ikke stedsmetadata til nettleseren.',
    'import.setFromGps': 'Sett fra GPS',
    'import.identifying': 'Identifiserer…',
    'import.failedOneGroup': 'Kunne ikke sette én gruppe i kø. Andre kan ha blitt satt i kø.',
    'import.saved': 'Satte {count} i kø for opplasting',
    'import.queuedSingle': 'Lagt til i synkøen',
    'counts.photo.one': '{count} bilde',
    'counts.photo.other': '{count} bilder',
    'counts.observation.one': '{count} observasjon',
    'counts.observation.other': '{count} observasjoner',
    'counts.group.one': '{count} gruppe',
    'counts.group.other': '{count} grupper',
    'photo.close': 'Lukk',
    'photo.previous': 'Forrige',
    'photo.next': 'Neste',
    'crop.editorTitle': 'AI-beskjæring',
    'crop.noCropHint': 'Trykk på et bilde for å angi AI-beskjæring',
    'crop.statusSome': '{cropped}/{total} AI-beskjæring',
    'visibility.private': 'Privat',
    'visibility.friends': 'Venner',
    'visibility.public': 'Offentlig',
  },
  sv_SE: {
    'app.name': 'Sporely',
    'auth.tagline': 'Fältobservationer, överallt.',
    'auth.signIn': 'Logga in',
    'auth.createAccount': 'Skapa konto',
    'auth.email': 'E-post',
    'auth.password': 'Lösenord',
    'auth.passwordMin': 'Minst 6 tecken',
    'auth.noAccount': 'Inget konto?',
    'auth.createOne': 'Skapa ett',
    'auth.alreadyHaveOne': 'Har du redan ett?',
    'auth.checkInbox': 'Kontrollera inkorgen för att bekräfta kontot.',
    'auth.resendEmail': 'Skicka igen',
    'auth.emailAlreadyConfirmed': 'Din e-post är redan bekräftad. Försök logga in.',
    'auth.couldNotResend': 'Kunde inte skicka igen: {message}',
    'auth.confirmationSent': 'Bekräftelsemejl skickat. Kontrollera inkorgen.',
    'auth.confirmationExpired': 'Din bekräftelselänk har gått ut. Ange din e-post nedan och begär en ny.',
    'auth.accessDenied': 'Åtkomst nekad. Försök igen.',
    'auth.genericError': 'Något gick fel. Försök igen.',
    'auth.localCaptchaHint': 'Lokal utveckling döljer Turnstile, men Supabase kräver fortfarande CAPTCHA på servern. För test på telefon kan du använda den deployade URL:en eller tillfälligt stänga av CAPTCHA i Supabase Auth.',
    'auth.existingAccount': 'Det finns redan ett konto med den e-posten. Logga in eller använd "Glömt lösenord" för att återställa det.',
    'common.sync': 'Synk',
    'common.pleaseWait': 'Vänta…',
    'common.cancel': 'Avbryt',
    'common.save': 'Spara',
    'common.delete': 'Radera',
    'common.clear': 'Rensa',
    'common.loading': 'Laddar…',
    'common.unknown': 'Okänd',
    'common.you': 'Du',
    'common.errorPrefix': 'Fel: {message}',
    'common.artsorakelError': 'Artsorakel: {message}',
    'common.close': 'Stäng',
    'home.sporelyCam': 'Sporely Cam',
    'home.importPhotos': 'Importera bilder',
    'home.recentFinds': 'Senaste fynd',
    'home.history': 'Historik →',
    'home.recentComments': 'Senaste kommentarer',
    'home.noObservations': 'Inga observationer ännu.',
    'home.noComments': 'Inga kommentarer ännu.',
    'home.unidentified': 'Obestämd',
    'stats.finds': 'Fynd',
    'stats.species': 'Arter',
    'stats.friendsActive': 'Aktiva vänner',
    'stats.friends': 'Vänner',
    'importSheet.title': 'Importera bilder',
    'importSheet.subtitle': 'Välj den snabbaste vägen, eller bläddra bland filer när du vill ha bäst chans att behålla originalmetadata.',
    'importSheet.photosAndVideos': 'Bilder och videor',
    'importSheet.quickPicker': 'Snabbväljare från ditt galleri.',
    'importSheet.browseFiles': 'Bläddra bland filer',
    'importSheet.heicHint': 'Bäst för original HEIC-metadata på vissa Android-telefoner.',
    'capture.acquiring': 'Hämtar position…',
    'capture.batchActive': 'Serie aktiv',
    'capture.done': 'KLAR',
    'capture.cameraAccessNeeded': 'Kameråtkomst krävs',
    'capture.tryAgain': 'Försök igen',
    'capture.cameraPermissionAndroid': 'Ge Sporely kameratillgång i Android-appens behörigheter och tryck sedan på "Försök igen".',
    'capture.cameraPermissionIphone': 'På iPhone: öppna Inställningar, hitta Safari eller din webbläsare och tillåt kameraåtkomst.',
    'capture.cameraPermissionFirefox': 'I Firefox: tryck på låsikonen i adressfältet och tillåt kameraåtkomst.',
    'capture.cameraPermissionSamsung': 'I Samsung Internet: tryck på låsikonen i adressfältet och tillåt kameraåtkomst.',
    'capture.cameraPermissionBrowser': 'Tryck på lås- eller kameraikonen i adressfältet, tillåt kameraåtkomst och tryck sedan på "Försök igen".',
    'capture.capturePhoto': 'Ta bild',
    'capture.noCameraFound': 'Ingen kamera hittades på den här enheten.',
    'capture.cameraStartFailed': 'Kameran kunde inte startas ({name}). Stäng andra appar som använder kameran och försök igen.',
    'capture.photoCaptured': 'Bild {count} tagen',
    'capture.lightReading': 'LJUS: {lux} LUX / F-STOPP: {fStop}',
    'review.review': 'Granskning',
    'review.addPhoto': 'Lägg till bild',
    'review.fieldMetadata': 'Fältmetadata',
    'review.location': 'Plats',
    'review.latLon': 'Lat/lon',
    'review.currentLocation': 'Nuvarande plats',
    'review.gpsAccuracy': 'GPS-noggrannhet',
    'review.altitude': 'Höjd',
    'review.sharing': 'Delning',
    'review.habitat': 'Habitat',
    'review.notes': 'Anteckningar',
    'review.fieldNotes': 'Fältanteckningar…',
    'review.idNeeded': 'Osäker ID',
    'review.createsOne': 'Skapar en observation i Sporely Cloud',
    'review.createsMany': 'Skapar observationer i Sporely Cloud',
    'review.noCaptures': 'Inga bilder ännu',
    'review.capturedRange': 'Tagen {start} — {end}',
    'review.identifying': 'Identifierar…',
    'review.noMatch': 'Artsorakel gav inga förslag',
    'review.aiUnavailable': 'Artsorakel är inte tillgängligt just nu.',
    'review.noPhotosToIdentify': 'Inga bilder att identifiera',
    'review.runningAi': 'Kör Artsorakel på {count}…',
    'review.notSignedIn': 'Inte inloggad',
    'review.noPhotosToSync': 'Inga bilder att synka',
    'review.syncing': 'Lägger till i synkkön…',
    'review.synced': 'Köade 1 observation med {count} ✓',
    'review.syncFailed': 'Kunde inte köa observationen: {message}',
    'review.uploadedComplete': 'Observationen är uppladdad med {count} bild(er) ✓',
    'detail.backHome': 'Hem',
    'detail.backFinds': 'Fynd',
    'detail.backMap': 'Karta',
    'detail.backGeneric': 'Tillbaka',
    'detail.unknownSpecies': 'Okänd art',
    'detail.species': 'Art',
    'detail.identifyAI': 'Identifiera med Artsorakel AI',
    'detail.location': 'Plats',
    'detail.currentLocation': 'Nuvarande plats',
    'detail.habitat': 'Habitat',
    'detail.notes': 'Anteckningar',
    'detail.idNeeded': 'Osäker ID',
    'detail.sharing': 'Delning',
    'detail.onlyOwnerOverwriteLocation': 'Bara ägaren kan skriva över platsen',
    'detail.currentGpsUnavailable': 'Nuvarande GPS är inte tillgänglig',
    'detail.overwriteLocationConfirm': 'Nuvarande plats kommer att skriva över den befintliga platsen. Fortsätta?',
    'detail.locationSet': 'Plats satt från nuvarande GPS',
    'detail.noPhotoToIdentify': 'Ingen bild att identifiera',
    'detail.couldNotLoadObservation': 'Kunde inte ladda observationen',
    'detail.onlyOwnerEdit': 'Bara ägaren kan redigera den här observationen',
    'detail.saveFailed': 'Sparande misslyckades: {message}',
    'detail.saved': 'Sparad ✓',
    'detail.deleteFailed': 'Radering misslyckades: {message}',
    'detail.onlyOwnerDelete': 'Bara ägaren kan radera den här observationen',
    'detail.confirmDeleteImage': 'Radera den här bilden? Detta kan inte ångras.',
    'detail.deleteConfirm': 'Radera denna observation? Detta kan inte ångras.',
    'detail.deleted': 'Observationen raderades',
    'detail.blockUser': 'Blockera användare',
    'detail.reportPost': 'Rapportera inlägg',
    'detail.blockUserConfirm': 'Blockera den här användaren? Du kommer inte längre att se deras inlägg och kommentarer.',
    'detail.blockFailed': 'Kunde inte blockera användare: ',
    'detail.userBlocked': 'Användare blockerad.',
    'detail.reportReason': 'Varför rapporterar du detta inlägg? (t.ex. spam, olämpligt)',
    'detail.reportFailed': 'Kunde inte rapportera: ',
    'detail.postReported': 'Inlägg rapporterat till administratörer.',
    'comments.title': 'Kommentarer',
    'comments.add': 'Lägg till en kommentar…',
    'comments.send': 'Skicka',
    'comments.couldNotLoad': 'Kunde inte ladda kommentarer.',
    'comments.none': 'Inga kommentarer ännu.',
    'comments.postFailed': 'Kunde inte posta kommentar: {message}',
    'comments.posted': 'Kommentar postad ✓',
    'comments.reportReason': 'Varför rapporterar du denna kommentar?',
    'comments.reportFailed': 'Kunde inte rapportera: ',
    'comments.commentReported': 'Kommentar rapporterad.',
    'comments.blockConfirm': 'Blockera den här användaren?',
    'comments.blockFailed': 'Kunde inte blockera: ',
    'comments.userBlocked': 'Användare blockerad.',
    'finds.search': 'Sök art, plats, anteckningar…',
    'finds.searchAria': 'Sök',
    'finds.clearSearch': 'Rensa sökning',
    'finds.documentedObservations': 'Dokumenterade observationer.',
    'finds.singleColumn': 'En kolumn',
    'finds.twoColumns': 'Två kolumner',
    'finds.threeColumns': 'Tre kolumner',
    'finds.uncertainIds': 'Osäkra ID:n',
    'finds.tinyGrid': 'Litet rutnät',
    'finds.newObservationAria': 'Ny observation',
    'finds.couldNotLoad': 'Kunde inte ladda fynd',
    'finds.noFriends': 'Inga vänners fynd ännu.',
    'finds.noObservations': 'Inga observationer ännu.',
    'finds.noObservationsCapture': 'Inga observationer ännu — gå ut och ta några!',
    'finds.noResults': 'Inga träffar för "{query}".',
    'finds.pendingUpload': 'Köad för uppladdning',
    'finds.pendingUploading': 'Laddar upp bild {current} av {total}…',
    'finds.pendingFinalizing': 'Slutför uppladdning…',
    'finds.pendingRetrying': 'Försöker ladda upp igen…',
    'finds.pullToRefresh': 'Dra ned för att uppdatera',
    'finds.releaseToRefresh': 'Släpp för att uppdatera',
    'finds.refreshing': 'Uppdaterar…',
    'finds.unidentified': 'Obestämd',
    'finds.observationCount.one': '{count} observation.',
    'finds.observationCount.other': '{count} observationer.',
    'finds.speciesCount.one': '{count} art',
    'finds.speciesCount.other': '{count} arter',
    'map.filter': 'Filtrera karta…',
    'map.clear': 'Rensa',
    'map.viewDetails': 'Visa detaljer →',
    'scope.mine': 'Mina',
    'scope.friends': 'Vänner',
    'scope.community': 'Offentligt',
    'scope.all': 'Alla',
    'profile.title': 'Profil',
    'profile.fullNameOptional': 'Fullständigt namn (valfritt)',
    'profile.saveProfile': 'Spara profil',
    'profile.addFriend': 'Lägg till vän',
    'profile.friendSearch': 'E-post, namn eller @användarnamn…',
    'profile.search': 'Sök',
    'profile.pendingRequests': 'Väntande förfrågningar',
    'profile.friends': 'Vänner',
    'profile.noFriends': 'Inga vänner ännu.',
    'profile.signOut': 'Logga ut',
    'profile.deleteAccount': 'Radera konto',
    'profile.changePhoto': 'Byt bild',
    'profile.usernameTaken': 'Användarnamnet är upptaget',
    'profile.saved': 'Profil sparad ✓',
    'profile.uploadFailed': 'Uppladdning misslyckades: {message}',
    'profile.photoUpdated': 'Bild uppdaterad ✓',
    'profile.searching': 'Söker…',
    'profile.noUsersFound': 'Inga användare hittades.',
    'profile.requestAlreadySent': 'Förfrågan har redan skickats',
    'profile.requestSent': 'Vänförfrågan skickad ✓',
    'profile.friendAccepted': 'Vän godkänd ✓',
    'profile.friendRemoved': 'Vän borttagen',
    'profile.deleteConfirm': 'Radera {email} permanent?\n\nDetta tar bort din profil, dina observationer, kommentarer, vänskaper och uppladdade bilder. Detta kan inte ångras.',
    'profile.deleting': 'Raderar…',
    'profile.deleteFunctionMissing': 'Funktionen för att radera konto är inte deployad ännu',
    'profile.deleteFailed': 'Kunde inte radera konto: {message}',
    'profile.accountDeleted': 'Konto raderat',
    'profile.accept': 'Acceptera',
    'profile.decline': 'Avböj',
    'profile.remove': 'Ta bort',
    'profile.sent': 'Skickad',
    'profile.add': 'Lägg till',
    'profile.cloudPlan': 'Kontostatus',
    'profile.cloudStorage': 'Konto',
    'profile.uploads': 'Bildupplösning',
    'profile.storage': 'Synkhistorik',
    'profile.storageUsage': 'Lagring',
    'profile.imageCount': 'Bilder',
    'profile.imageResolutionFree': '2MP',
    'profile.imageResolutionPro': '12MP',
    'profile.imageCountValue.one': '{count} bild',
    'profile.imageCountValue.other': '{count} bilder',
    'profile.syncNever': 'Ingen synk från den här enheten ännu',
    'profile.syncTodayAt': 'I dag kl. {time}',
    'profile.syncAt': '{date} kl. {time}',
    'profile.storageUnknown': 'Inte spårat ännu',
    'profile.storageUsedOnly': '{used} använt',
    'profile.storageUsedOfQuota': '{used} / {total}',
    'profile.termsOfService': 'Användarvillkor',
    'avatar.cropPhoto': 'Beskär bild',
    'avatar.hint': 'Nyp för att zooma · Dra för att flytta',
    'avatar.usePhoto': 'Använd bild',
    'nav.home': 'Hem',
    'nav.finds': 'Fynd',
    'nav.map': 'Karta',
    'nav.profile': 'Profil',
    'settings.title': 'Inställningar',
    'settings.appearance': 'Utseende',
    'settings.auto': 'Auto',
    'settings.light': 'Ljus',
    'settings.dark': 'Mörk',
    'settings.language': 'Språk',
    'settings.appLanguage': 'Appspråk',
    'settings.photoImport': 'Bildimport',
    'settings.newObservationAfter': 'Ny observation efter',
    'settings.min': 'min',
    'settings.photoGapHint': 'Bildimport från enheten grupperar bilder baserat på tiden mellan bilderna.',
    'settings.imageResolution': 'Bildupplösning',
    'settings.imageResolutionReduced': 'Reducerad (2MP)',
    'settings.imageResolutionMax': 'Max (12MP)',
    'settings.sync': 'Synk',
    'settings.syncOverMobileData': 'Synka via mobildata',
    'settings.defaultVisibility': 'Standard synlighet',
    'settings.data': 'Data',
    'settings.clearLocalCache': 'Rensa lokal cache',
    'settings.clearLocalCacheHint': 'Rensar tillfälliga importbilder och webbläsarens mediecache. Köade observationer behålls.',
    'settings.clearLocalCacheConfirm': 'Rensa tillfälliga importbilder och webbläsarens mediecache? Köade observationer behålls.',
    'settings.localCacheCleared': 'Lokal cache rensad',
    'settings.localCacheFailed': 'Kunde inte rensa cache: {message}',
    'import.processing': 'Bearbetar…',
    'import.readingFiles': 'Läser filer…',
    'import.importingFile': 'Importerar {current} av {total}…',
    'import.readingTimestamps': 'Läser tidsstämplar…',
    'import.convertingFile': 'Konverterar {current} av {total}…',
    'import.failed': 'Import misslyckades',
    'import.saveAll': 'Köa alla',
    'import.currentGpsUnavailable': 'Nuvarande GPS är inte tillgänglig',
    'import.overwriteExifConfirm': 'Nuvarande plats kommer att skriva över EXIF-platsen. Fortsätta?',
    'import.noHeicGps': 'Ingen GPS hittades i denna HEIC-bild. I vissa iPhone-uppladdningar på webben exponeras inte platsmetadata till webbläsaren.',
    'import.setFromGps': 'Sätt från GPS',
    'import.identifying': 'Identifierar…',
    'import.failedOneGroup': 'Det gick inte att köa en grupp. Andra kan ha köats.',
    'import.saved': 'Köade {count} för uppladdning',
    'import.queuedSingle': 'Tillagd i synkkön',
    'counts.photo.one': '{count} bild',
    'counts.photo.other': '{count} bilder',
    'counts.observation.one': '{count} observation',
    'counts.observation.other': '{count} observationer',
    'counts.group.one': '{count} grupp',
    'counts.group.other': '{count} grupper',
    'photo.close': 'Stäng',
    'photo.previous': 'Föregående',
    'photo.next': 'Nästa',
    'crop.editorTitle': 'AI-beskärning',
    'crop.noCropHint': 'Tryck på en bild för att ange AI-beskärning',
    'crop.statusSome': '{cropped}/{total} AI-beskärning',
    'visibility.private': 'Privat',
    'visibility.friends': 'Vänner',
    'visibility.public': 'Offentlig',
  },
  de_DE: {
    'app.name': 'Sporely',
    'auth.tagline': 'Feldbeobachtungen, überall.',
    'auth.signIn': 'Anmelden',
    'auth.createAccount': 'Konto erstellen',
    'auth.email': 'E-Mail',
    'auth.password': 'Passwort',
    'auth.passwordMin': 'Mindestens 6 Zeichen',
    'auth.noAccount': 'Kein Konto?',
    'auth.createOne': 'Eins erstellen',
    'auth.alreadyHaveOne': 'Hast du schon eins?',
    'auth.checkInbox': 'Prüfe deinen Posteingang, um dein Konto zu bestätigen.',
    'auth.resendEmail': 'E-Mail erneut senden',
    'auth.emailAlreadyConfirmed': 'Deine E-Mail ist bereits bestätigt. Versuche dich anzumelden.',
    'auth.couldNotResend': 'Konnte nicht erneut senden: {message}',
    'auth.confirmationSent': 'Bestätigungs-E-Mail gesendet. Prüfe deinen Posteingang.',
    'auth.confirmationExpired': 'Dein Bestätigungslink ist abgelaufen. Gib unten deine E-Mail ein und fordere einen neuen an.',
    'auth.accessDenied': 'Zugriff verweigert. Bitte versuche es erneut.',
    'auth.genericError': 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
    'auth.localCaptchaHint': 'Lokale Entwicklung blendet Turnstile aus, aber Supabase verlangt weiterhin CAPTCHA auf dem Server. Für Tests auf dem Handy verwende die deployte URL oder deaktiviere CAPTCHA vorübergehend in Supabase Auth.',
    'auth.existingAccount': 'Für diese E-Mail gibt es bereits ein Konto. Melde dich an oder nutze "Passwort vergessen", um es zurückzusetzen.',
    'common.sync': 'Sync',
    'common.pleaseWait': 'Bitte warten…',
    'common.cancel': 'Abbrechen',
    'common.save': 'Speichern',
    'common.delete': 'Löschen',
    'common.clear': 'Leeren',
    'common.loading': 'Lädt…',
    'common.unknown': 'Unbekannt',
    'common.you': 'Du',
    'common.errorPrefix': 'Fehler: {message}',
    'common.artsorakelError': 'Artsorakel: {message}',
    'common.close': 'Schließen',
    'home.sporelyCam': 'Sporely Cam',
    'home.importPhotos': 'Fotos importieren',
    'home.recentFinds': 'Letzte Funde',
    'home.history': 'Verlauf →',
    'home.recentComments': 'Letzte Kommentare',
    'home.noObservations': 'Noch keine Beobachtungen.',
    'home.noComments': 'Noch keine Kommentare.',
    'home.unidentified': 'Unbestimmt',
    'stats.finds': 'Funde',
    'stats.species': 'Arten',
    'stats.friendsActive': 'Aktive Freunde',
    'stats.friends': 'Freunde',
    'importSheet.title': 'Fotos importieren',
    'importSheet.subtitle': 'Wähle den schnellsten Weg oder durchsuche Dateien, wenn du die beste Chance auf originale Metadaten willst.',
    'importSheet.photosAndVideos': 'Fotos und Videos',
    'importSheet.quickPicker': 'Schnellauswahl aus deiner Galerie.',
    'importSheet.browseFiles': 'Dateien durchsuchen',
    'importSheet.heicHint': 'Am besten für originale HEIC-Metadaten auf manchen Android-Handys.',
    'capture.acquiring': 'Standort wird ermittelt…',
    'capture.batchActive': 'Serie aktiv',
    'capture.done': 'FERTIG',
    'capture.cameraAccessNeeded': 'Kamerazugriff erforderlich',
    'capture.tryAgain': 'Erneut versuchen',
    'capture.cameraPermissionAndroid': 'Erlaube Sporely den Kamerazugriff in den Android-App-Berechtigungen und tippe dann auf "Erneut versuchen".',
    'capture.cameraPermissionIphone': 'Auf dem iPhone: Öffne Einstellungen, finde Safari oder deinen Browser und erlaube den Kamerazugriff.',
    'capture.cameraPermissionFirefox': 'In Firefox: Tippe auf das Schloss im Adressfeld und erlaube den Kamerazugriff.',
    'capture.cameraPermissionSamsung': 'In Samsung Internet: Tippe auf das Schloss im Adressfeld und erlaube den Kamerazugriff.',
    'capture.cameraPermissionBrowser': 'Tippe auf das Schloss- oder Kamerasymbol im Adressfeld, erlaube den Kamerazugriff und tippe dann auf "Erneut versuchen".',
    'capture.capturePhoto': 'Foto aufnehmen',
    'capture.noCameraFound': 'Auf diesem Gerät wurde keine Kamera gefunden.',
    'capture.cameraStartFailed': 'Die Kamera konnte nicht gestartet werden ({name}). Schließe andere Apps mit Kamerazugriff und versuche es erneut.',
    'capture.photoCaptured': 'Foto {count} aufgenommen',
    'capture.lightReading': 'LICHT: {lux} LUX / BLENDE: {fStop}',
    'review.review': 'Prüfen',
    'review.addPhoto': 'Foto hinzufügen',
    'review.fieldMetadata': 'Feldmetadaten',
    'review.location': 'Ort',
    'review.latLon': 'Breite/Länge',
    'review.currentLocation': 'Aktueller Ort',
    'review.gpsAccuracy': 'GPS-Genauigkeit',
    'review.altitude': 'Höhe',
    'review.sharing': 'Freigabe',
    'review.habitat': 'Habitat',
    'review.notes': 'Notizen',
    'review.fieldNotes': 'Feldnotizen…',
    'review.idNeeded': 'Unsichere ID',
    'review.createsOne': 'Erstellt eine Beobachtung in Sporely Cloud',
    'review.createsMany': 'Erstellt Beobachtungen in Sporely Cloud',
    'review.noCaptures': 'Noch keine Aufnahmen',
    'review.capturedRange': 'Aufgenommen {start} — {end}',
    'review.identifying': 'Identifiziere…',
    'review.noMatch': 'Artsorakel hat keinen Vorschlag geliefert',
    'review.aiUnavailable': 'Artsorakel ist derzeit nicht verfügbar.',
    'review.noPhotosToIdentify': 'Keine Fotos zum Identifizieren',
    'review.runningAi': 'Artsorakel läuft für {count}…',
    'review.notSignedIn': 'Nicht angemeldet',
    'review.noPhotosToSync': 'Keine Fotos zum Synchronisieren',
    'review.syncing': 'Füge zur Sync-Warteschlange hinzu…',
    'review.synced': '1 Beobachtung mit {count} in die Warteschlange gestellt ✓',
    'review.syncFailed': 'Beobachtung konnte nicht in die Warteschlange gestellt werden: {message}',
    'review.uploadedComplete': 'Beobachtung mit {count} Bild(ern) hochgeladen ✓',
    'detail.backHome': 'Start',
    'detail.backFinds': 'Funde',
    'detail.backMap': 'Karte',
    'detail.backGeneric': 'Zurück',
    'detail.unknownSpecies': 'Unbekannte Art',
    'detail.species': 'Art',
    'detail.identifyAI': 'Mit Artsorakel AI bestimmen',
    'detail.location': 'Ort',
    'detail.currentLocation': 'Aktueller Ort',
    'detail.habitat': 'Habitat',
    'detail.notes': 'Notizen',
    'detail.idNeeded': 'Unsichere ID',
    'detail.sharing': 'Freigabe',
    'detail.onlyOwnerOverwriteLocation': 'Nur der Eigentümer kann den Ort überschreiben',
    'detail.currentGpsUnavailable': 'Aktuelles GPS nicht verfügbar',
    'detail.overwriteLocationConfirm': 'Der aktuelle Ort überschreibt den bestehenden Ort. Fortfahren?',
    'detail.locationSet': 'Ort aus aktuellem GPS gesetzt',
    'detail.noPhotoToIdentify': 'Kein Foto zum Identifizieren',
    'detail.couldNotLoadObservation': 'Beobachtung konnte nicht geladen werden',
    'detail.onlyOwnerEdit': 'Nur der Eigentümer kann diese Beobachtung bearbeiten',
    'detail.saveFailed': 'Speichern fehlgeschlagen: {message}',
    'detail.saved': 'Gespeichert ✓',
    'detail.deleteFailed': 'Löschen fehlgeschlagen: {message}',
    'detail.onlyOwnerDelete': 'Nur der Eigentümer kann diese Beobachtung löschen',
    'detail.confirmDeleteImage': 'Dieses Bild löschen? Das kann nicht rückgängig gemacht werden.',
    'detail.deleteConfirm': 'Diese Beobachtung löschen? Das kann nicht rückgängig gemacht werden.',
    'detail.deleted': 'Beobachtung gelöscht',
    'detail.blockUser': 'Benutzer blockieren',
    'detail.reportPost': 'Beitrag melden',
    'detail.blockUserConfirm': 'Diesen Benutzer blockieren? Du wirst seine Beiträge und Kommentare nicht mehr sehen.',
    'detail.blockFailed': 'Benutzer konnte nicht blockiert werden: ',
    'detail.userBlocked': 'Benutzer blockiert.',
    'detail.reportReason': 'Warum meldest du diesen Beitrag? (z.B. Spam, unangemessen)',
    'detail.reportFailed': 'Meldung fehlgeschlagen: ',
    'detail.postReported': 'Beitrag an Administratoren gemeldet.',
    'comments.title': 'Kommentare',
    'comments.add': 'Kommentar hinzufügen…',
    'comments.send': 'Senden',
    'comments.couldNotLoad': 'Kommentare konnten nicht geladen werden.',
    'comments.none': 'Noch keine Kommentare.',
    'comments.postFailed': 'Kommentar konnte nicht gesendet werden: {message}',
    'comments.posted': 'Kommentar gesendet ✓',
    'comments.reportReason': 'Warum meldest du diesen Kommentar?',
    'comments.reportFailed': 'Meldung fehlgeschlagen: ',
    'comments.commentReported': 'Kommentar gemeldet.',
    'comments.blockConfirm': 'Diesen Benutzer blockieren?',
    'comments.blockFailed': 'Blockieren fehlgeschlagen: ',
    'comments.userBlocked': 'Benutzer blockiert.',
    'finds.search': 'Art, Ort, Notizen suchen…',
    'finds.searchAria': 'Suchen',
    'finds.clearSearch': 'Suche löschen',
    'finds.documentedObservations': 'Dokumentierte Beobachtungen.',
    'finds.singleColumn': 'Einspaltige Ansicht',
    'finds.twoColumns': 'Zwei Spalten',
    'finds.threeColumns': 'Drei Spalten',
    'finds.uncertainIds': 'Unsichere IDs',
    'finds.tinyGrid': 'Kleines Raster',
    'finds.newObservationAria': 'Neue Beobachtung',
    'finds.couldNotLoad': 'Funde konnten nicht geladen werden',
    'finds.noFriends': 'Noch keine Funde von Freunden.',
    'finds.noObservations': 'Noch keine Beobachtungen.',
    'finds.noObservationsCapture': 'Noch keine Beobachtungen — geh raus und erfasse welche!',
    'finds.noResults': 'Keine Treffer für "{query}".',
    'finds.pendingUpload': 'Zum Upload vorgemerkt',
    'finds.pendingUploading': 'Bild {current} von {total} wird hochgeladen…',
    'finds.pendingFinalizing': 'Upload wird abgeschlossen…',
    'finds.pendingRetrying': 'Upload wird erneut versucht…',
    'finds.pullToRefresh': 'Zum Aktualisieren nach unten ziehen',
    'finds.releaseToRefresh': 'Zum Aktualisieren loslassen',
    'finds.refreshing': 'Aktualisiere…',
    'finds.unidentified': 'Unbestimmt',
    'finds.observationCount.one': '{count} Beobachtung.',
    'finds.observationCount.other': '{count} Beobachtungen.',
    'finds.speciesCount.one': '{count} Art',
    'finds.speciesCount.other': '{count} Arten',
    'map.filter': 'Karte filtern…',
    'map.clear': 'Leeren',
    'map.viewDetails': 'Details anzeigen →',
    'scope.mine': 'Meine',
    'scope.friends': 'Freunde',
    'scope.community': 'Öffentlich',
    'scope.all': 'Alle',
    'profile.title': 'Profil',
    'profile.fullNameOptional': 'Vollständiger Name (optional)',
    'profile.saveProfile': 'Profil speichern',
    'profile.addFriend': 'Freund hinzufügen',
    'profile.friendSearch': 'E-Mail, Name oder @benutzername…',
    'profile.search': 'Suchen',
    'profile.pendingRequests': 'Ausstehende Anfragen',
    'profile.friends': 'Freunde',
    'profile.noFriends': 'Noch keine Freunde.',
    'profile.signOut': 'Abmelden',
    'profile.deleteAccount': 'Konto löschen',
    'profile.changePhoto': 'Foto ändern',
    'profile.usernameTaken': 'Benutzername ist bereits vergeben',
    'profile.saved': 'Profil gespeichert ✓',
    'profile.uploadFailed': 'Upload fehlgeschlagen: {message}',
    'profile.photoUpdated': 'Foto aktualisiert ✓',
    'profile.searching': 'Suche…',
    'profile.noUsersFound': 'Keine Benutzer gefunden.',
    'profile.requestAlreadySent': 'Anfrage bereits gesendet',
    'profile.requestSent': 'Freundschaftsanfrage gesendet ✓',
    'profile.friendAccepted': 'Freund angenommen ✓',
    'profile.friendRemoved': 'Freund entfernt',
    'profile.deleteConfirm': '{email} dauerhaft löschen?\n\nDadurch werden dein Profil, deine Beobachtungen, Kommentare, Freundschaften und hochgeladenen Bilder entfernt. Das kann nicht rückgängig gemacht werden.',
    'profile.deleting': 'Lösche…',
    'profile.deleteFunctionMissing': 'Die Funktion zum Löschen des Kontos ist noch nicht deployt',
    'profile.deleteFailed': 'Konto konnte nicht gelöscht werden: {message}',
    'profile.accountDeleted': 'Konto gelöscht',
    'profile.accept': 'Annehmen',
    'profile.decline': 'Ablehnen',
    'profile.remove': 'Entfernen',
    'profile.sent': 'Gesendet',
    'profile.add': 'Hinzufügen',
    'profile.cloudPlan': 'Kontostatus',
    'profile.cloudStorage': 'Konto',
    'profile.uploads': 'Bildauflösung',
    'profile.storage': 'Sync-Verlauf',
    'profile.storageUsage': 'Speicher',
    'profile.imageCount': 'Bilder',
    'profile.imageResolutionFree': '2MP',
    'profile.imageResolutionPro': '12MP',
    'profile.imageCountValue.one': '{count} Bild',
    'profile.imageCountValue.other': '{count} Bilder',
    'profile.syncNever': 'Noch keine Syncs von diesem Gerät',
    'profile.syncTodayAt': 'Heute um {time}',
    'profile.syncAt': '{date} um {time}',
    'profile.storageUnknown': 'Noch nicht erfasst',
    'profile.storageUsedOnly': '{used} genutzt',
    'profile.storageUsedOfQuota': '{used} / {total}',
    'profile.termsOfService': 'Nutzungsbedingungen',
    'avatar.cropPhoto': 'Foto zuschneiden',
    'avatar.hint': 'Zum Zoomen zusammenziehen · Zum Verschieben ziehen',
    'avatar.usePhoto': 'Foto verwenden',
    'nav.home': 'Start',
    'nav.finds': 'Funde',
    'nav.map': 'Karte',
    'nav.profile': 'Profil',
    'settings.title': 'Einstellungen',
    'settings.appearance': 'Darstellung',
    'settings.auto': 'Auto',
    'settings.light': 'Hell',
    'settings.dark': 'Dunkel',
    'settings.language': 'Sprache',
    'settings.appLanguage': 'App-Sprache',
    'settings.photoImport': 'Fotoimport',
    'settings.newObservationAfter': 'Neue Beobachtung nach',
    'settings.min': 'min',
    'settings.photoGapHint': 'Der Fotoimport von deinem Gerät gruppiert Bilder anhand der Zeit zwischen den Fotos.',
    'settings.imageResolution': 'Bildauflösung',
    'settings.imageResolutionReduced': 'Reduziert (2MP)',
    'settings.imageResolutionMax': 'Max. (12MP)',
    'settings.sync': 'Sync',
    'settings.syncOverMobileData': 'Über mobile Daten synchronisieren',
    'settings.defaultVisibility': 'Standard-Sichtbarkeit',
    'settings.data': 'Daten',
    'settings.clearLocalCache': 'Lokalen Cache leeren',
    'settings.clearLocalCacheHint': 'Leert temporäre Importfotos und den Mediencache des Browsers. Beobachtungen in der Warteschlange bleiben erhalten.',
    'settings.clearLocalCacheConfirm': 'Temporäre Importfotos und Browser-Mediencache löschen? Beobachtungen in der Warteschlange bleiben erhalten.',
    'settings.localCacheCleared': 'Lokaler Cache geleert',
    'settings.localCacheFailed': 'Cache konnte nicht geleert werden: {message}',
    'import.processing': 'Verarbeite…',
    'import.readingFiles': 'Lese Dateien…',
    'import.importingFile': 'Importiere {current} von {total}…',
    'import.readingTimestamps': 'Lese Zeitstempel…',
    'import.convertingFile': 'Konvertiere {current} von {total}…',
    'import.failed': 'Import fehlgeschlagen',
    'import.saveAll': 'Alle in die Warteschlange',
    'import.currentGpsUnavailable': 'Aktuelles GPS nicht verfügbar',
    'import.overwriteExifConfirm': 'Der aktuelle Ort überschreibt den EXIF-Ort. Fortfahren?',
    'import.noHeicGps': 'Für dieses HEIC-Foto wurden keine GPS-Daten gefunden. Bei manchen iPhone-Webuploads werden Standortmetadaten nicht an den Browser weitergegeben.',
    'import.setFromGps': 'Aus GPS setzen',
    'import.identifying': 'Identifiziere…',
    'import.failedOneGroup': 'Eine Gruppe konnte nicht in die Warteschlange gestellt werden. Andere wurden möglicherweise bereits eingereiht.',
    'import.saved': '{count} zum Upload vorgemerkt',
    'import.queuedSingle': 'Zur Sync-Warteschlange hinzugefügt',
    'counts.photo.one': '{count} Foto',
    'counts.photo.other': '{count} Fotos',
    'counts.observation.one': '{count} Beobachtung',
    'counts.observation.other': '{count} Beobachtungen',
    'counts.group.one': '{count} Gruppe',
    'counts.group.other': '{count} Gruppen',
    'photo.close': 'Schließen',
    'photo.previous': 'Vorheriges',
    'photo.next': 'Nächstes',
    'crop.editorTitle': 'KI-Ausschnitt',
    'crop.noCropHint': 'Foto antippen, um KI-Ausschnitt festzulegen',
    'crop.statusSome': '{cropped}/{total} KI-Ausschnitt',
    'visibility.private': 'Privat',
    'visibility.friends': 'Freunde',
    'visibility.public': 'Öffentlich',
  },
}

let currentLocale = FALLBACK_LOCALE
const listeners = new Set()

function resolveLocale(locale) {
  const text = String(locale || '').trim().replace('-', '_')
  if (!text) return FALLBACK_LOCALE
  const prefix = text.split('_', 1)[0].toLowerCase()
  if (prefix === 'nb' || prefix === 'nn' || prefix === 'no') return 'nb_NO'
  if (prefix === 'sv') return 'sv_SE'
  if (prefix === 'de') return 'de_DE'
  if (prefix === 'en') return 'en'
  return FALLBACK_LOCALE
}

function detectLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return resolveLocale(stored)
  } catch {}

  const candidates = [...(navigator.languages || []), navigator.language]
  for (const candidate of candidates) {
    const locale = resolveLocale(candidate)
    if (SUPPORTED_LOCALES.includes(locale)) return locale
  }
  return FALLBACK_LOCALE
}

function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
}

function messageFor(key) {
  return messages[currentLocale]?.[key] ?? messages[FALLBACK_LOCALE]?.[key] ?? key
}

function setText(selector, key, params) {
  const el = document.querySelector(selector)
  if (el) el.textContent = t(key, params)
}

function setAllText(selector, values) {
  const nodes = document.querySelectorAll(selector)
  values.forEach((value, index) => {
    if (nodes[index]) nodes[index].textContent = value
  })
}

function setPlaceholder(selector, key, params) {
  const el = document.querySelector(selector)
  if (el) el.placeholder = t(key, params)
}

function setAria(selector, key, params) {
  const el = document.querySelector(selector)
  if (el) el.setAttribute('aria-label', t(key, params))
}

function setTitle(selector, key, params) {
  const el = document.querySelector(selector)
  if (el) el.setAttribute('title', t(key, params))
}

export function t(key, params = {}) {
  return interpolate(messageFor(key), params)
}

export function tp(baseKey, count, params = {}) {
  const variant = count === 1 ? 'one' : 'other'
  return t(`${baseKey}.${variant}`, { count, ...params })
}

export function getLocale() {
  return currentLocale
}

export function getIntlLocale() {
  return currentLocale.replace('_', '-')
}

export function getTaxonomyLanguage() {
  const prefix = currentLocale.split('_', 1)[0]
  if (prefix === 'nb') return 'no'
  if (prefix === 'sv') return 'sv'
  if (prefix === 'de') return 'de'
  return 'en'
}

export function translateVisibility(value) {
  return t(`visibility.${value || 'private'}`)
}

export function formatDate(value, options = {}) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(getIntlLocale(), options).format(date)
}

export function formatTime(value, options = {}) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(getIntlLocale(), options).format(date)
}

export function formatLightReading(lux, fStop) {
  return t('capture.lightReading', { lux, fStop })
}

export function setLocale(locale) {
  const next = resolveLocale(locale)
  if (next === currentLocale) return
  currentLocale = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {}
  applyStaticTranslations()
  listeners.forEach(listener => listener(next))
}

export function onLocaleChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function applyStaticTranslations() {
  document.documentElement.lang = getIntlLocale()
  document.title = t('app.name')

  setText('#login-form .auth-title', 'auth.signIn')
  setText('#login-email-label', 'auth.email')
  setText('#login-password-label', 'auth.password')
  setText('#login-btn', 'auth.signIn')
  const loginBtn = document.getElementById('login-btn')
  if (loginBtn) loginBtn.dataset.label = t('auth.signIn')
  setText('#login-switch-prefix', 'auth.noAccount')
  setText('#show-signup', 'auth.createOne')

  setText('#signup-form .auth-title', 'auth.createAccount')
  setText('#signup-email-label', 'auth.email')
  setText('#signup-password-label', 'auth.password')
  setText('#signup-btn', 'auth.createAccount')
  const signupBtn = document.getElementById('signup-btn')
  if (signupBtn) signupBtn.dataset.label = t('auth.createAccount')
  setText('#signup-switch-prefix', 'auth.alreadyHaveOne')
  setText('#show-login', 'auth.signIn')
  setText('.auth-tagline', 'auth.tagline')

  setPlaceholder('#signup-password', 'auth.passwordMin')
  setPlaceholder('#finds-search-input', 'finds.search')
  setPlaceholder('#review-notes', 'review.fieldNotes')
  setPlaceholder('#detail-taxon-input', 'detail.unknownSpecies')
  setPlaceholder('#detail-notes', 'review.fieldNotes')
  setPlaceholder('#comment-input', 'comments.add')
  setPlaceholder('#map-search-input', 'map.filter')
  setPlaceholder('#profile-fullname', 'profile.fullNameOptional')
  setPlaceholder('#friend-search-input', 'profile.friendSearch')

  setText('#header-sync-tag span', 'common.sync')
  setText('#home-recent-finds-title', 'home.recentFinds')
  setText('#recent-history-link', 'home.history')
  setText('#home-recent-comments-title', 'home.recentComments')
  setText('#home-stat-finds-label', 'stats.finds')
  setText('#home-stat-species-label', 'stats.species')
  setText('#home-stat-friends-label', 'stats.friendsActive')
  setText('#ac-sporely-cam .action-card-label', 'home.sporelyCam')
  setText('#ac-import .action-card-label', 'home.importPhotos')

  setText('#import-source-title', 'importSheet.title')
  setText('#import-source-sheet .sheet-subtitle', 'importSheet.subtitle')
  setText('#import-source-photos .sheet-option-title', 'importSheet.photosAndVideos')
  setText('#import-source-photos .sheet-option-copy', 'importSheet.quickPicker')
  setText('#import-source-files .sheet-option-title', 'importSheet.browseFiles')
  setText('#import-source-files .sheet-option-copy', 'importSheet.heicHint')

  setText('#gps-display', 'capture.acquiring')
  setText('.batch-active-label', 'capture.batchActive')
  setText('#done-btn', 'capture.done')
  setText('.camera-denied-title', 'capture.cameraAccessNeeded')
  setText('#camera-retry-btn', 'capture.tryAgain')

  setText('#add-photo-label', 'review.addPhoto')
  setText('#screen-review .review-session-label', 'review.review')
  setText('#screen-review .field-meta-header', 'review.fieldMetadata')
  setAllText('#screen-review .field-meta-key', [
    t('review.location'),
    t('review.latLon'),
    t('review.gpsAccuracy'),
    t('review.altitude'),
    t('review.sharing'),
    t('review.idNeeded'),
  ])
  setAllText('#screen-review .detail-field-label', [
    t('review.habitat'),
    t('review.notes'),
  ])
  setText('#location-apply-btn', 'review.currentLocation')
  setText('#review-cancel-btn', 'common.cancel')
  setText('#review-save-btn', 'common.save')
  setText('#screen-review .sync-footer-text', 'review.createsOne')
  setAllText('#review-visibility .vis-option span', [
    t('visibility.private'),
    t('visibility.friends'),
    t('visibility.public'),
  ])

  setText('#detail-back-label', 'detail.backFinds')
  setText('#detail-title-common', 'detail.unknownSpecies')
  setAllText('#screen-find-detail .detail-field-label', [
    t('detail.species'),
    t('detail.location'),
    t('detail.habitat'),
    t('detail.notes'),
    t('detail.sharing'),
  ])
  setText('#detail-current-location-btn', 'detail.currentLocation')
  setText('#screen-find-detail .field-meta-key', 'detail.idNeeded')
  setText('#comments-section .comments-title', 'comments.title')
  setText('#comment-send-btn', 'comments.send')
  setText('#detail-delete-btn', 'common.delete')
  setText('#detail-cancel-btn', 'common.cancel')
  setText('#detail-save-btn', 'common.save')
  setAllText('#detail-visibility .vis-option span', [
    t('visibility.private'),
    t('visibility.friends'),
    t('visibility.public'),
  ])

  setText('#import-back-label', 'detail.backHome')
  setText('#import-cancel-btn', 'common.cancel')
  setText('#import-save-btn', 'import.saveAll')
  setText('#screen-import-review .sync-footer-text', 'review.createsMany')

  setAllText('#screen-finds .scope-tab', [t('scope.mine'), t('scope.friends'), t('scope.community')])
  setText('#finds-subtitle', 'finds.documentedObservations')
  setText('#finds-refresh-label', 'finds.pullToRefresh')

  setText('#profile-header-label', 'profile.title')
  setText('#profile-save-btn', 'profile.saveProfile')
  setText('#profile-add-friend-title', 'profile.addFriend')
  setText('#profile-pending-title', 'profile.pendingRequests')
  setText('#profile-friends-title', 'profile.friends')
  setText('#profile-cloud-plan-header', 'profile.cloudStorage')
  setText('#profile-cloud-upload-key', 'profile.uploads')
  setText('#profile-cloud-usage-key', 'profile.storage')
  setText('#profile-storage-key', 'profile.storageUsage')
  setText('#profile-image-count-key', 'profile.imageCount')
  setText('#profile-cloud-plan-title', 'profile.cloudPlan')
  setText('#sign-out-btn', 'profile.signOut')
  setText('#delete-account-btn', 'profile.deleteAccount')
  const friendsEmpty = document.querySelector('#friends-list > div')
  if (friendsEmpty) friendsEmpty.textContent = t('profile.noFriends')

  setText('.avatar-crop-header', 'avatar.cropPhoto')
  setText('.avatar-crop-hint', 'avatar.hint')
  setText('#avatar-crop-cancel', 'common.cancel')
  setText('#avatar-crop-confirm', 'avatar.usePhoto')

  setText('#nav-home .nav-label', 'nav.home')
  setText('#nav-finds .nav-label', 'nav.finds')
  setText('#nav-map .nav-label', 'nav.map')
  setText('#nav-profile .nav-label', 'nav.profile')
  setAllText('#screen-map .map-scope-btn', [t('scope.mine'), t('scope.friends'), t('scope.all')])

  setText('.settings-title', 'settings.title')
  setText('#settings-appearance-label', 'settings.appearance')
  setText('.theme-seg-btn[data-theme="auto"]', 'settings.auto')
  setText('.theme-seg-btn[data-theme="light"]', 'settings.light')
  setText('.theme-seg-btn[data-theme="dark"]', 'settings.dark')
  setText('#settings-language-label', 'settings.language')
  setText('#settings-language-select-label', 'settings.appLanguage')
  setText('#settings-photo-import-label', 'settings.photoImport')
  setText('#settings-gap-label', 'settings.newObservationAfter')
  setText('.settings-gap-unit', 'settings.min')
  setText('.settings-gap-hint', 'settings.photoGapHint')
  setText('#settings-image-resolution-label', 'settings.imageResolution')
  setText('#settings-resolution-reduced', 'settings.imageResolutionReduced')
  setText('#settings-resolution-max', 'settings.imageResolutionMax')
  setText('#settings-sync-label', 'settings.sync')
  setText('#settings-mobile-sync-label', 'settings.syncOverMobileData')
  setText('#settings-default-visibility-label', 'settings.defaultVisibility')
  setText('#settings-default-visibility-private', 'visibility.private')
  setText('#settings-default-visibility-friends', 'visibility.friends')
  setText('#settings-default-visibility-public', 'visibility.public')
  setText('#settings-data-label', 'settings.data')
  setText('#settings-clear-cache-btn', 'settings.clearLocalCache')
  setText('#settings-clear-cache-hint', 'settings.clearLocalCacheHint')
  setAria('#settings-btn', 'settings.title')
  setAria('#settings-close-btn', 'common.close')
  setAria('#finds-search-btn', 'finds.searchAria')
  setAria('#finds-search-clear', 'finds.clearSearch')
  setAria('#finds-filter-uncertain', 'finds.uncertainIds')
  setAria('#home-fab', 'finds.newObservationAria')
  setAria('#finds-fab', 'finds.newObservationAria')
  setAria('#map-fab', 'finds.newObservationAria')
  setAria('#map-search-clear', 'map.clear')
  setAria('#profile-avatar-btn', 'profile.changePhoto')
  setAria('#detail-back', 'detail.backGeneric')
  setAria('#photo-viewer-close', 'photo.close')
  setAria('#photo-viewer-prev', 'photo.previous')
  setAria('#photo-viewer-next', 'photo.next')
  setAria('#shutter-btn', 'capture.capturePhoto')

  setTitle('#finds-view-cards', 'finds.singleColumn')
  setTitle('#finds-view-two', 'finds.twoColumns')
  setTitle('#finds-view-three', 'finds.threeColumns')
  setTitle('#finds-filter-uncertain', 'finds.uncertainIds')
  setTitle('#finds-view-tiles', 'finds.tinyGrid')

  const versionEl = document.getElementById('settings-version')
  if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`
}

export function initI18n() {
  currentLocale = detectLocale()
  applyStaticTranslations()
  const localeSelect = document.getElementById('settings-language-select')
  if (localeSelect) localeSelect.value = currentLocale
}
