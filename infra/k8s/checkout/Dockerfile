# prism/checkout:v1: a stand-in checkout worker that logs plausible order processing lines.
FROM busybox:1.36
COPY worker.sh /worker.sh
USER 65534:65534
CMD ["sh", "/worker.sh"]
