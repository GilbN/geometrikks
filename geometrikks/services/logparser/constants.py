import re

MONITORED_IP_TYPES: list[str] = ['PUBLIC', 'ALLOCATED APNIC', 'ALLOCATED ARIN', 'ALLOCATED RIPE NCC', 'ALLOCATED LACNIC', 'ALLOCATED AFRINIC']
ALLOWED_GEOIP_LOCALES: list[str] = ["de","en","es","fr","ja","pt-BR","ru","zh-CN"]
GEOIP_LOCALES_DEFAULT: list[str] = ["en"]


class Rgx:
    """Regular expression patterns for the log file."""
    RE_IPV4_PATTERN = r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})'
    RE_IPV6_PATTERN = r'(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))' # NOQA
    REMOTE_USER_PATTERN = r'(\S+)'
    DATE_AND_TIME_PATTERN = r'(\d{2}\/[A-Z]{1}[a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s(?:\+|\-)\d{4})'
    REQUEST_PATTERN = r'(?:)'
    METHOD_PATTERN = r'([A-Z]+)'
    REFERRER_PATTERN = r'(.+?)'
    HTTP_VERSION_PATTERN = r'(HTTP\/[1-3]\.[0-9])'
    STATUS_CODE_PATTERN = r'(\d{3})'
    BYTES_SENT_PATTERN = r'(\d{1,99})'
    URL_PATTERN = r'(?:\-|.+)'
    HOST_PATTERN = r'(.+?)'
    USER_AGENT_PATTERN = r'(.+?)'
    REQUEST_TIME_PATTERN = r'(.+?)'
    CONNECT_TIME_PATTERN = r'(.+?)'
    CITY_PATTERN = r'(.+?)'
    COUNTRY_CODE_PATTERN = r'(.+?)'

def create_log_pattern(ip_pattern: str) -> re.Pattern[str]:
    """Create a regular expression pattern for the log file.

    Args:
        ip_pattern (str): The regular expression pattern for the IP address.

    Returns:
        re.Pattern[str]: The regular expression pattern for the log file.
    """
    return re.compile(rf'''
    (?P<ipaddress>{ip_pattern})
    \s-\s
    (?P<remote_user>{Rgx.REMOTE_USER_PATTERN})
    \s\[
    (?P<dateandtime>{Rgx.DATE_AND_TIME_PATTERN})\]
    \s?"
    (?P<request>
        ({Rgx.REQUEST_PATTERN}
            (?P<method>{Rgx.METHOD_PATTERN})\s
            (?P<referrer>{Rgx.REFERRER_PATTERN})\s
            (?P<http_version>{Rgx.HTTP_VERSION_PATTERN})
            |
            [^"]*
        )
    )"
    \s
    (?P<status_code>{Rgx.STATUS_CODE_PATTERN})
    \s
    (?P<bytes_sent>{Rgx.BYTES_SENT_PATTERN})
    \s?"
    (?P<url>{Rgx.URL_PATTERN})"
    (?P<host>{Rgx.HOST_PATTERN})"
    (?P<user_agent>{Rgx.USER_AGENT_PATTERN})
    "\s?"
    (?P<request_time>{Rgx.REQUEST_TIME_PATTERN})"
    \s"
    (?P<connect_time>{Rgx.CONNECT_TIME_PATTERN})"
    \s?"
    (?P<city>{Rgx.CITY_PATTERN})"
    \s"
    (?P<country_code>{Rgx.COUNTRY_CODE_PATTERN})"
    ''', re.VERBOSE | re.IGNORECASE) # NOQA
    
def ipv4_pattern() -> re.Pattern[str]:
    """Return the full regular expression pattern for an IPv4 log line."""
    return create_log_pattern(Rgx.RE_IPV4_PATTERN)

def ipv6_pattern() -> re.Pattern[str]:
    """Return the full regular expression pattern for an IPv6 log line."""
    return create_log_pattern(Rgx.RE_IPV6_PATTERN)

def ipv4() -> re.Pattern[str]:
    """Return the regular expression pattern for an IPv4 address."""
    return re.compile(Rgx.RE_IPV4_PATTERN)

def ipv6() -> re.Pattern[str]:
    """Return the regular expression pattern for an IPv6 address."""
    return re.compile(Rgx.RE_IPV6_PATTERN)