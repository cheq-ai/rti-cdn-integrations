export interface RTIResponse {
  /**
   * API version
   */
  version: number;

  /**
   * Indicates whether the request is valid or invalid
   */
  isInvalid: boolean;

  /**
   * Threat type code identified for request
   *
   * | Code | Type | Group | Description |
   * | ---- | ---- | ----- | ----------- |
   * | 0 | Valid | | |
   * | 2 | Scrapers | Invalid Bot Activity | Scrapers are used for content scraping from web applications. A web scraper extracts underlying code as well as stored data. This extracted information can be used then to retrieve business intelligence, to replicate the web service and more. |
   * | 3 | Automation Tools | Invalid Bot Activity | Automation tools are used to perform automatic activity usually at scale in a repetitive and fast manner. Such activity can be sometimes executed for malicious purposes such as false-clicks and fraudulent display of web-placed ads. |
   * | 4 | Frequency Capping | Invalid Suspicious Activity | Ad fatigue occurs when your audience sees your ads too often and disproportionally which causes your campaigns to become less effective. Using frequency capping, you can limit the number of times your ads appear to the same user. |
   * | 5 | Abnormal Rate Limit | Invalid Suspicious Activity | An abnormal and disproportional number of clicks on ads that is performed by users posing as legitimate users but without any intention of following through and convert. |
   * | 6 | Excessive Rate Limit | Invalid Malicious Activity | An excessive number of clicks on ads that is performed by users posing as legitimate users but without any intention of following through and convert. |
   * | 7 | Disabled JavaScript | Invalid Malicious Activity | When JavaScript is disabled in the user browser, certain features on a website might not work or even the website might not operate completely. Users with disabled JS deliberately don't intent to interact with the website the way it was designed to. |
   * | 8 | Behavioral Anomalies | Invalid Malicious Activity | Behavioral anomalies is a method of detecting individuals with hostile intentions by observing their behavior and activities on digital assets. |
   * | 9 | Click Farm | Invalid Malicious Activity | A click farm is an organized fraud that leverages tools and large groups of humans to manually click on paid ads online. Click farms have people clicking on ads with no intent of normally converting. |
   * | 10 | Malicious Bots | Invalid Bot Activity | A malicious bot is a malware designed to perform a variety of attack patterns. |
   * | 11 | False Representation | Invalid Malicious Activity | False Representation such as User Agent Spoofing is the situation where the user information is modified to hide and lie about its real characteristics and identity. It is most often seen with bots trying to hide their tracks, but some malicious human users will occasionally engage in this way as well. |
   * | 13 | Data Centers | Invalid Suspicious Activity | Data-center traffic is any traffic that has been detected to originate in a data-center. As such, it is very likely to have come from a server rather than a laptop, smartphone, tablet or other personal device that may indicate a source of non-human traffic. |
   * | 14 | VPN | Invalid Suspicious Activity | VPNs are being used to access services or websites that are out of reach, which can only be done with a VPN or proxy. This may be considered as a suspicious use to commit fraud. |
   * | 15 | Proxy | Invalid Suspicious Activity | Many proxies frequently hide or facilitate invalid activity. Invalid proxy activity can originate from an intermediary proxy device that exists to manipulate traffic counts or create/pass-on non-human or invalid traffic or otherwise failing to meet protocol validation. |
   * | 16 | Disabled Cookies | Invalid Malicious Activity | Disabling the browser’s cookies is common with bots and fraudsters. Users that have their cookies disabled will not be able to use most of the websites functionality. This means that these users would not be able to progress within the funnel and most likely won’t convert. |
   * | 17 | Click Hijacking | Invalid Malicious Activity | Click Hijacking is an attack vector that tricks a user into clicking a web element which is invisible or disguised as another element. This can cause users to unwittingly download malware, visit malicious web pages, provide credentials or sensitive information, transfer money, or purchase products online. |
   * | 18 | Network Anomalies | Invalid Malicious Activity | User traffic that includes one or more attributes (e.g., IP, user cookie) associated with known irregular patterns, such as non-disclosed auto-refresh traffic, duplicate clicks, and attribute mismatch. |
   * | 19 | Good Bot | Known Bots | A known bot is any bot that performs useful or helpful tasks that aren't detrimental to a user's experience on the Internet. Because good bots can share similar characteristics with malicious bots, the challenge is ensuring good bots aren’t blocked when putting together a bot management strategy. |
   * | 20 | Crawlers | Undeclared Bots | Undeclared crawlers are automated programs from legitimate organizations that systematically browse the internet to index and gather information about web pages, but do not explicitly identify themselves as bots or disclose their purpose or origin. |
   * | 21 | Geo Exclusions | Invalid Suspicious Activity | Fraudsters tend to obfuscate their true geolocation by using different kinds of tools such as VPN’s and Proxies. This allows them to  interact with campaigns that are outside of the original targeting strategy and potentially facilitate targeted attacks. |
   */
  threatTypeCode: number;

  /**
   * Request ID generated by CHEQ RTI
   */
  requestId: string;

  /**
   * Data to set the CHEQ RTI Cookie
   */
  setCookie: string;
}
