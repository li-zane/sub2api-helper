// Legacy mock workers model a combined Web/OAuth protocol. Opt in only for
// downstream regression fixtures; the production guard never honors this flag.
process.env.TOSUB2_TEST_LEGACY_IMPORT = "1";
process.env.NODE_ENV ||= "test";
