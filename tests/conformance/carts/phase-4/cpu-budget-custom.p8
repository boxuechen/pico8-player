pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
frame=0
while true do
 frame+=1
 local x=0
 for i=1,1000 do x+=i end
 local a=0x5000+(frame-1)*12
 poke4(a,stat(1))
 poke4(a+4,stat(7))
 poke4(a+8,time())
 flip()
end
