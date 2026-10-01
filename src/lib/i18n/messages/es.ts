/**
 * Spanish (es) message catalog — the product's primary and only UI locale.
 *
 * Group keys by surface. Copy is product language ("pendientes", "boda"),
 * never project-management language.
 */
export const es = {
  metadata: {
    title: "listalaboda.com",
    description: "Organiza tu boda, un pendiente a la vez.",
  },
  home: {
    brand: "listalaboda.com",
    tagline: "Organiza tu boda, un pendiente a la vez.",
    status: "Estamos preparando la base de la aplicación.",
    login: "Entrar",
    signup: "Crear cuenta",
  },
  common: {
    brand: "listalaboda.com",
    goHome: "Ir al inicio",
    goToMyWeddings: "Ir a mis bodas",
    login: "Entrar",
    signup: "Crear cuenta",
    loading: "Un momento…",
    unexpectedError: "Algo salió mal. Inténtalo de nuevo en unos minutos.",
  },
  notFound: {
    title: "No encontramos esta página",
    body: "Puede que el enlace esté mal escrito o que no tengas acceso.",
  },
  auth: {
    fields: {
      email: "Correo electrónico",
      password: "Contraseña",
      passwordHint: "Mínimo 8 caracteres.",
    },
    login: {
      title: "Entra a tu boda",
      intro: "Usa el correo y la contraseña de tu cuenta.",
      submit: "Entrar",
      submitting: "Entrando…",
      noAccount: "¿Aún no tienes cuenta?",
      createAccount: "Crea una aquí",
      invalidCredentials: "El correo o la contraseña no son correctos.",
      emailNotConfirmed: "Confirma tu correo antes de entrar. Revisa tu bandeja de entrada.",
      callbackFailed: "No pudimos completar el acceso. Vuelve a entrar.",
    },
    signup: {
      title: "Crea tu cuenta",
      intro: "Solo necesitas un correo y una contraseña.",
      submit: "Crear cuenta",
      submitting: "Creando cuenta…",
      haveAccount: "¿Ya tienes cuenta?",
      goToLogin: "Entra aquí",
      checkEmailTitle: "Revisa tu correo",
      checkEmailBody:
        "Si el correo es válido, te enviamos un enlace para confirmar tu cuenta. Ábrelo desde este mismo navegador para continuar.",
      weakPassword: "Elige una contraseña más segura.",
    },
    invitePending:
      "Te invitaron a una boda. Entra o crea tu cuenta y te llevaremos directo a ella.",
    validation: {
      emailRequired: "Escribe tu correo electrónico.",
      emailInvalid: "Escribe un correo electrónico válido.",
      passwordRequired: "Escribe tu contraseña.",
      passwordTooShort: "La contraseña debe tener al menos 8 caracteres.",
      passwordTooLong: "La contraseña es demasiado larga.",
    },
    rateLimited: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.",
  },
  app: {
    nav: {
      label: "Navegación principal",
      myWeddings: "Mis bodas",
      createWedding: "Crear boda",
      signedInAs: "Sesión iniciada como",
      logout: "Cerrar sesión",
    },
    weddings: {
      title: "Mis bodas",
      emptyTitle: "Todavía no tienes una boda",
      emptyBody: "Crea tu boda para empezar a organizarla, y luego invita a tu pareja.",
      emptyCta: "Crear mi boda",
      createAnother: "Crear otra boda",
      noDate: "Fecha por definir",
      roleOwner: "Organizas esta boda",
      roleCollaborator: "Colaboras en esta boda",
    },
  },
  weddingNew: {
    title: "Crea tu boda",
    intro: "Puedes cambiar estos datos más adelante.",
    nameLabel: "Nombre de la boda",
    nameHint: "Por ejemplo: «Boda de Ana y Luis».",
    dateLabel: "Fecha de la boda (opcional)",
    dateHint: "Si aún no la tienen, déjala en blanco.",
    submit: "Crear boda",
    submitting: "Creando boda…",
    cancel: "Volver a mis bodas",
    validation: {
      nameRequired: "Escribe un nombre para la boda.",
      nameTooLong: "El nombre es demasiado largo (máximo 200 caracteres).",
      dateInvalid: "Escribe una fecha válida.",
    },
  },
  wedding: {
    dateLabel: "Fecha",
    noDate: "Por definir",
    yourRole: "Tu papel",
    members: "Personas en esta boda",
    membersSummary: {
      owners: "Organizan",
      collaborators: "Colaboran",
    },
    membersNote: "Por privacidad, aquí solo mostramos cuántas personas participan.",
    joined: "¡Te damos la bienvenida! Ya formas parte de esta boda.",
    alreadyMember: "Ya tienes acceso a esta boda.",
    backToWeddings: "Volver a mis bodas",
  },
  roles: {
    owner: {
      label: "Organiza la boda",
      description: "Acceso completo a la boda, incluido invitar a otras personas.",
    },
    collaborator: {
      label: "Colabora en la boda",
      description: "Puede colaborar en la boda, pero no invitar a otras personas.",
    },
  },
  invites: {
    title: "Invita a alguien a tu boda",
    intro:
      "Crea un enlace de invitación y compártelo con tu pareja o con quien te ayude. Cada enlace sirve una sola vez y vence en 7 días.",
    collaboratorNote: "Solo quienes organizan la boda pueden invitar a otras personas.",
    roleLegend: "¿Qué podrá hacer?",
    emailLabel: "Correo de la persona invitada (opcional)",
    emailHint: "Si lo escribes, solo una cuenta con ese correo podrá usar el enlace.",
    submit: "Crear enlace de invitación",
    submitting: "Creando enlace…",
    created: "Enlace creado. Cópialo y compártelo; no podremos mostrártelo de nuevo.",
    linkLabel: "Enlace de invitación",
    copy: "Copiar enlace",
    copied: "Enlace copiado",
    copyFailed: "No pudimos copiarlo. Selecciona el enlace y cópialo a mano.",
    listTitle: "Invitaciones enviadas",
    listEmpty: "Aún no has creado invitaciones.",
    anyone: "Cualquiera con el enlace",
    createdOn: "Creada el",
    expiresOn: "Vence el",
    status: {
      pending: "Pendiente",
      accepted: "Aceptada",
      revoked: "Cancelada",
      expired: "Vencida",
    },
    revoke: "Cancelar invitación",
    revoking: "Cancelando…",
    revokeFailed: "No pudimos cancelar la invitación. Recarga la página e inténtalo de nuevo.",
    lostLinkHint: "¿Perdiste un enlace? Cancélalo y crea uno nuevo.",
    validation: {
      emailInvalid: "Escribe un correo electrónico válido.",
      roleInvalid: "Elige qué podrá hacer la persona invitada.",
    },
  },
  inviteAccept: {
    title: "Te invitaron a una boda",
    body: "Al aceptar, entrarás a la boda con la cuenta que tienes abierta.",
    signedInAs: "Cuenta:",
    submit: "Unirme a la boda",
    submitting: "Uniéndote…",
    notYou: "¿No es tu cuenta?",
    switchAccount: "Cerrar sesión y usar otra",
  },
  inviteInvalid: {
    title: "Este enlace de invitación ya no es válido.",
    body: "Pídele a quien te invitó que cree un enlace nuevo.",
  },
} as const;

/** Shape every future locale catalog must satisfy. */
export type Messages = typeof es;
