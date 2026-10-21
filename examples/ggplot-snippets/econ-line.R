# title: US personal savings rate
g <- ggplot(economics, aes(x = date, y = psavert)) +
  geom_line() +
  labs(x = "Date", y = "Savings rate (%)")
